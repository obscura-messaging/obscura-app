package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.wire.WireCodec
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.FriendListSync
import obscura.client.v1.Client.FriendRecord
import obscura.client.v1.Client.FriendStatus as WireFriendStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest
import java.util.Collections

/** The primary owns the friend list; linked devices follow its FriendListSync. */
class FriendListAuthorityTest {
    private val peer = "019f025a-0000-7de6-84b6-000000000002"
    private val peerDevice = "019f025a-0000-7de6-84b6-0000000000d2"
    private val primary = "019f025a-0000-7de6-84b6-0000000000d0"
    private val otherLinked = "019f025a-0000-7de6-84b6-0000000000d3"

    private fun friendRequest(username: String) = ClientMessage.newBuilder()
        .setFriendRequest(obscura.client.v1.friendRequest { this.username = username }).build()

    private fun friendAccept() = ClientMessage.newBuilder().setFriendAccept(obscura.client.v1.friendAccept {}).build()

    private fun sync(version: Long, vararg friends: FriendData) = ClientMessage.newBuilder().setFriendListSync(
        FriendListSync.newBuilder().setVersion(version).addAllFriends(friends.map(WireCodec::encodeFriend))
    ).build()

    private fun ObscuraClient.version() = db.friendQueries.selectVersion().executeAsOneOrNull() ?: 0L

    private suspend fun linked() = authenticatedClient(primaryDeviceId = primary)

    @Test fun `a linked device acknowledges friend requests and accepts and changes nothing`() = runBlocking {
        val c = linked()
        c.route(friendRequest("alice"), peer, peerDevice, "env-1")
        c.db.friendQueries.insert(peer, "alice", FriendStatus.PENDING_SENT.value)
        c.route(friendAccept(), peer, peerDevice, "env-2")

        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_SENT)), c.getFriends())
        assertEquals(0L, c.inbox.depth())
        assertEquals(0L, c.version())
    }

    @Test fun `a linked device replaces its list with a newer sync from its primary`() = runBlocking {
        val c = linked()
        c.db.friendQueries.insert("stale", "stale", FriendStatus.ACCEPTED.value)
        val alice = FriendData(peer, "alice", FriendStatus.ACCEPTED)
        val bob = FriendData("019f025a-0000-7de6-84b6-000000000004", "bob", FriendStatus.PENDING_RECEIVED)

        c.route(sync(3, alice, bob), SELF_USER_ID, primary, "env-1")

        assertEquals(listOf(alice, bob), c.getFriends())
        assertEquals(3L, c.version())
        assertEquals(0L, c.inbox.depth())
    }

    @Test fun `a sync that is not newer, not from the primary, or malformed is ignored`() = runBlocking {
        val c = linked()
        val alice = FriendData(peer, "alice", FriendStatus.ACCEPTED)
        c.route(sync(5, alice), SELF_USER_ID, primary, "env-0")
        val mallory = FriendData("019f025a-0000-7de6-84b6-000000000009", "mallory", FriendStatus.ACCEPTED)
        val unspecified = ClientMessage.newBuilder().setFriendListSync(FriendListSync.newBuilder().setVersion(9)
            .addFriends(FriendRecord.newBuilder().setUserId(peer).setUsername("x").setStatus(WireFriendStatus.FRIEND_STATUS_UNSPECIFIED))).build()

        c.route(sync(5, mallory), SELF_USER_ID, primary, "env-1")
        c.route(sync(4, mallory), SELF_USER_ID, primary, "env-2")
        c.route(sync(9, mallory), SELF_USER_ID, otherLinked, "env-3")
        c.route(sync(9, mallory), peer, primary, "env-4")
        c.route(unspecified, SELF_USER_ID, primary, "env-5")

        assertEquals(listOf(alice), c.getFriends())
        assertEquals(5L, c.version())
        assertEquals(5, c.getDebugLog().count { it.contains("FRIEND_LIST_SYNC from") && it.contains("ignored") })
    }

    @Test fun `the primary ignores a sync`() = runBlocking {
        val c = authenticatedClient()
        c.route(sync(9, FriendData(peer, "alice", FriendStatus.ACCEPTED)), SELF_USER_ID, otherLinked, "env-1")
        assertEquals(emptyList<FriendData>(), c.getFriends())
        assertEquals(0L, c.version())
    }

    @Test fun `friend changes are primary only`() = runBlocking {
        val c = linked()
        c.db.friendQueries.insert(peer, "alice", FriendStatus.PENDING_RECEIVED.value)
        for (call in listOf<suspend () -> Unit>(
            { c.addFriendByCode(FriendCode.encode(peer, "alice")) },
            { c.acceptFriend(peer) },
            { c.removeFriend(peer) },
            { c.approveLink("code") },
        )) {
            val error = runCatching { call() }.exceptionOrNull()
            assertTrue(error is ObscuraError.NotPrimary, "got $error")
            assertEquals("NOT_PRIMARY", (error as ObscuraError).code)
        }
        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_RECEIVED)), c.getFriends())
    }

    @Test fun `every change on the primary increments the version and sends the whole list to its other devices`() = runBlocking {
        MockWebServer().use { server ->
            FakeObscuraServer().use { fake ->
                server.start()
                val linkedDevice = fake.register(SELF_USER_ID)
                val sent = Collections.synchronizedList(mutableListOf<SendMessageRequest>())
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                        "/v1/keys/$SELF_USER_ID/devices/${linkedDevice.deviceId}" ->
                            MockResponse.Builder().body(linkedDevice.consumeBundle().toString()).build()
                        "/v1/messages" -> {
                            sent.add(SendMessageRequest.parseFrom(request.body!!.toByteArray()))
                            MockResponse.Builder().body("").build()
                        }
                        else -> MockResponse.Builder().code(404).build()
                    }
                }
                val c = sessionClient(server.url("/").toString().trimEnd('/'), storedSession())
                assertTrue(c.auth.restore())
                c.devices.add(SELF_USER_ID, listOf(linkedDevice.deviceId))

                c.route(friendRequest("alice"), peer, peerDevice, "env-1")
                c.removeFriend(peer)

                val syncs = sent.map { request ->
                    val submission = request.recipientsList.single().submissionsList.single()
                    assertEquals(linkedDevice.deviceId, UuidCodec.uuidString(submission.deviceId))
                    linkedDevice.messenger.decryptAndCommit(SELF_DEVICE_ID, submission.message,
                        record = { linkedDevice.directory.addInTransaction(SELF_USER_ID, SELF_DEVICE_ID) }) { ClientMessage.parseFrom(it) }
                        .friendListSync
                }
                assertEquals(listOf(1L, 2L), syncs.map { it.version })
                assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_RECEIVED)), syncs[0].friendsList.map { WireCodec.decodeFriend(it) })
                assertEquals(0, syncs[1].friendsCount)
                assertEquals(2L, c.version())
                c.auth.end()
                Unit
            }
        }
    }

    @Test fun `a sync that cannot be sent is logged and leaves the change in place`() = runBlocking {
        val c = authenticatedClient()
        c.devices.add(SELF_USER_ID, listOf(otherLinked))

        c.route(friendRequest("alice"), peer, peerDevice, "env-1")

        assertEquals(FriendStatus.PENDING_RECEIVED, c.getFriends().single().status)
        assertEquals(1L, c.version())
        assertTrue(c.getDebugLog().any { it.contains("FRIEND_LIST_SYNC v1 not accepted") || it.contains("FRIEND_LIST_SYNC not sent") })
    }
}
