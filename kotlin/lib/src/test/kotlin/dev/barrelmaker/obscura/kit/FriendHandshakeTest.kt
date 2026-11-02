package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
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
                            remote.messenger.decryptAndCommit(SELF_DEVICE_ID, sent.message,
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
}
