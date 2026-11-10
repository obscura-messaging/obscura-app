package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import obscura.client.v1.Client.EncryptedMessage
import obscura.client.v1.Client.ClientMessage
import org.json.JSONArray
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class FriendHandshakeTest {
    private fun envelope(userId: String, deviceId: String, submission: SendMessageRequest.Submission) =
        Envelope.newBuilder().setId(UuidCodec.uuidToBytes(UUID.randomUUID()))
            .setSenderUserId(UuidCodec.uuidToBytes(UUID.fromString(userId)))
            .setSenderDeviceId(UuidCodec.uuidToBytes(UUID.fromString(deviceId)))
            .setMessage(submission.message).build()

    @Test fun `a fast encrypted acceptance before a failed request response is never rolled back`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            FakeObscuraServer().use { devices ->
                val remote = devices.register(UUID.randomUUID().toString())
                val client = sessionClient(server.url("/").toString(), storedSession())
                assertTrue(client.auth.restore())
                val stateBeforeAcceptance = AtomicReference<FriendStatus?>()
                val stateBeforeResponse = AtomicReference<FriendStatus?>()
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        if (request.url.encodedPath != "/v1/messages") {
                            return MockResponse.Builder().body(org.json.JSONObject().put("bundles", JSONArray().put(remote.consumeBundle())).toString()).build()
                        }
                        // The self sync after the acceptance covers only this account and has no submission.
                        val parsed = SendMessageRequest.parseFrom(request.body!!.toByteArray())
                        if (parsed.recipientsList.sumOf { it.submissionsCount } == 0) {
                            return MockResponse.Builder().body("").build()
                        }
                        runBlocking {
                            stateBeforeAcceptance.set(client.getFriends().singleOrNull()?.status)
                            val sent = parsed.recipientsList.single().submissionsList.single()
                            remote.messenger.decryptAndCommit(SELF_DEVICE_ID, EncryptedMessage.parseFrom(sent.message),
                                record = { remote.directory.addInTransaction(SELF_USER_ID, SELF_DEVICE_ID) }) { it }
                            val accept = ClientMessage.newBuilder().setFriendAccept(obscura.client.v1.friendAccept {}).build()
                            val reply = remote.messenger.prepareSubmission(SELF_DEVICE_ID, accept)
                            client.receive(envelope(remote.userId, remote.deviceId, reply)) {}
                            stateBeforeResponse.set(client.getFriends().singleOrNull()?.status)
                        }
                        return MockResponse.Builder().code(500).body("request response unavailable").build()
                    }
                }

                val error = runCatching {
                    client.addFriendByCode(FriendCode.encode(remote.userId, "label from code"))
                }.exceptionOrNull()

                assertTrue(error is ObscuraError.SendFailed)
                assertEquals(FriendStatus.PENDING_SENT, stateBeforeAcceptance.get())
                assertEquals(FriendStatus.ACCEPTED, stateBeforeResponse.get())
                assertEquals(FriendStatus.ACCEPTED, client.getFriends().single().status)
                assertEquals("label from code", client.getFriends().single().username)
                client.auth.end()
                Unit
            }
        }
    }

    @Test fun `friend handshake happy paths, crossed requests, self-sync and validation branches`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            FakeObscuraServer().use { devices ->
                val remote = devices.register(UUID.randomUUID().toString())
                val linkedDevice = devices.register(SELF_USER_ID)
                val client = sessionClient(server.url("/").toString().trimEnd('/'), storedSession())
                assertTrue(client.auth.restore())
                client.devices.add(SELF_USER_ID, listOf(linkedDevice.deviceId))

                val sentMessages = java.util.Collections.synchronizedList(mutableListOf<SendMessageRequest>())
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        val path = request.url.encodedPath
                        return when {
                            path == "/v1/keys/${remote.userId}" ->
                                MockResponse.Builder().body(org.json.JSONObject().put("bundles", JSONArray().put(remote.consumeBundle())).toString()).build()
                            path == "/v1/keys/$SELF_USER_ID/devices/${linkedDevice.deviceId}" ->
                                MockResponse.Builder().body(linkedDevice.consumeBundle().toString()).build()
                            path == "/v1/messages" -> {
                                sentMessages.add(SendMessageRequest.parseFrom(request.body!!.toByteArray()))
                                MockResponse.Builder().body("").build()
                            }
                            else -> MockResponse.Builder().code(404).build()
                        }
                    }
                }

                // friendCode() encodes self userId and username
                assertEquals(FriendCode.encode(SELF_USER_ID, "self"), client.friendCode())

                // Cannot befriend yourself
                val selfError = runCatching { client.befriend(SELF_USER_ID, "self") }.exceptionOrNull()
                assertTrue(selfError is ObscuraError.InvalidArgument)

                // acceptFriend on unknown user throws InvalidArgument
                val unknownAccept = runCatching { client.acceptFriend(remote.userId) }.exceptionOrNull()
                assertTrue(unknownAccept is ObscuraError.InvalidArgument)

                // removeFriend when friend does not exist does not send sync
                client.removeFriend(remote.userId)
                assertTrue(sentMessages.isEmpty())

                // addFriendByCode strips whitespace and soft hyphens, sends FriendRequest to peer and FriendListSync to self
                val rawCode = FriendCode.encode(remote.userId, "bob")
                val decoratedCode = " ${rawCode.substring(0, 4)}\u00AD${rawCode.substring(4)}\n"
                client.addFriendByCode(decoratedCode)
                assertEquals(FriendStatus.PENDING_SENT, client.getFriends().single().status)
                assertEquals(2, sentMessages.size)

                // Calling befriend again while PENDING_SENT re-sends FriendRequest without another FriendListSync
                client.befriend(remote.userId, "bob-renamed")
                assertEquals(3, sentMessages.size)
                assertEquals("bob", client.getFriends().single().username)

                // Incoming FRIEND_REQUEST from a PENDING_SENT peer (crossed requests) delegates to acceptFriend
                client.route(
                    ClientMessage.newBuilder().setFriendRequest(obscura.client.v1.friendRequest { username = "bob" }).build(),
                    remote.userId,
                    remote.deviceId,
                    "env-crossed",
                )
                assertEquals(FriendStatus.ACCEPTED, client.getFriends().single().status)
                assertEquals(5, sentMessages.size) // FriendAccept + FriendListSync

                // Calling befriend when already ACCEPTED is a no-op
                client.befriend(remote.userId, "bob")
                assertEquals(5, sentMessages.size)

                // Calling acceptFriend when already ACCEPTED sends FriendAccept but does not re-sync
                client.acceptFriend(remote.userId)
                assertEquals(6, sentMessages.size)

                // Incoming FRIEND_REQUEST from an already ACCEPTED peer replies with FriendAccept
                client.route(
                    ClientMessage.newBuilder().setFriendRequest(obscura.client.v1.friendRequest { username = "bob" }).build(),
                    remote.userId,
                    remote.deviceId,
                    "env-accepted-req",
                )
                assertEquals(7, sentMessages.size)
                assertTrue(client.getDebugLog().any { it.contains("acceptance replied") })

                // removeFriend when friend exists removes friend and syncs
                client.removeFriend(remote.userId)
                assertTrue(client.getFriends().isEmpty())
                assertEquals(8, sentMessages.size)

                // befriend when peer is PENDING_RECEIVED delegates to acceptFriend, sends FriendAccept, updates status and syncs
                client.route(
                    ClientMessage.newBuilder().setFriendRequest(obscura.client.v1.friendRequest { username = "bob" }).build(),
                    remote.userId,
                    remote.deviceId,
                    "env-pending-recv",
                )
                assertEquals(FriendStatus.PENDING_RECEIVED, client.getFriends().single().status)
                assertEquals(9, sentMessages.size)
                client.befriend(remote.userId, "bob")
                assertEquals(FriendStatus.ACCEPTED, client.getFriends().single().status)
                assertEquals(11, sentMessages.size)

                client.auth.end()
                Unit
            }
        }
    }
}
