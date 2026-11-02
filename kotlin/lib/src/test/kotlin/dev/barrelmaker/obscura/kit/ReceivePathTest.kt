package dev.barrelmaker.obscura.kit

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client
import obscura.client.v1.Client.ClientMessage
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** [ObscuraClient.route] with hand-built decrypted messages: what each arm stores and announces. */
class ReceivePathTest {
    private val peer = "019f025a-0000-7de6-84b6-000000000002"
    private val peerDevice = "019f025a-0000-7de6-84b6-0000000000d2"

    private fun appEntry(entryId: String, model: String = "pix", timestamp: Long = 1_700_000_000_000) =
        ClientMessage.newBuilder().setTimestamp(timestamp).setAppEntry(obscura.client.v1.appEntry {
            this.model = model
            id = entryId
            this.timestamp = timestamp
            data = ByteString.copyFrom("payload".toByteArray())
        }).build()

    private fun friendRequest(username: String) = ClientMessage.newBuilder()
        .setFriendRequest(obscura.client.v1.friendRequest { this.username = username }).build()

    private fun friendAccept() = ClientMessage.newBuilder().setFriendAccept(obscura.client.v1.friendAccept {}).build()

    private fun typing(contextId: String, state: Client.TypingState) = ClientMessage.newBuilder()
        .setTypingSignal(obscura.client.v1.typingSignal {
            this.contextId = contextId
            this.state = state
        }).build()

    private suspend fun ObscuraClient.receive(message: ClientMessage, envelopeId: String = "env-1", device: String = peerDevice) =
        route(message, peer, device, envelopeId)

    // ── Timestamps ────────────────────────────────────────────

    @Test
    fun `a past timestamp is unchanged and a future one is capped at now plus a minute`() {
        assertEquals(1_700_000_000_000L, clampFutureTimestamp(1_700_000_000_000L, nowMs = 1_800_000_000_000L))
        assertEquals(1_000L + 60_000L, clampFutureTimestamp(Long.MAX_VALUE / 2, nowMs = 1_000L))
    }

    @Test
    fun `a uint64 above 2 to the 63 arrives negative and is capped`() {
        val asSigned = java.lang.Long.parseUnsignedLong("18446744073709551615")
        assertEquals(61_000L, clampFutureTimestamp(asSigned, nowMs = 1_000L))
    }

    @Test
    fun `a stored entry's sentAt is clamped`() = runBlocking {
        val c = authenticatedClient()
        c.receive(appEntry("e", timestamp = Long.MAX_VALUE))
        assertTrue(c.inbox.peek().single().sentAt!! <= System.currentTimeMillis() + 60_000L)
    }

    // ── Inbox ─────────────────────────────────────────────────

    @Test
    fun `a new entry is inboxed and announced once, a redelivery neither`() = runBlocking {
        val c = authenticatedClient()

        c.receive(appEntry("entry-1"), envelopeId = "env-1")
        c.receive(appEntry("entry-1"), envelopeId = "env-1")

        assertEquals(1L, c.inbox.depth())
        assertEquals("pix", c.messageReceived.tryReceive().getOrNull())
        assertNull(c.messageReceived.tryReceive().getOrNull())
    }

    @Test
    fun `a distinct envelope carrying the same entry is a separate row`() = runBlocking {
        val c = authenticatedClient()
        c.receive(appEntry("entry-1"), envelopeId = "env-1")
        c.receive(appEntry("entry-1"), envelopeId = "env-2")
        assertEquals(2L, c.inbox.depth())
    }

    @Test
    fun `an inbox row records the authenticated sender`() = runBlocking {
        val c = authenticatedClient()
        c.receive(appEntry("entry-1"))

        val row = c.inbox.peek().single()
        assertEquals(peer, row.senderUserId)
        assertEquals(peerDevice, row.senderDeviceId)
        assertEquals("pix", row.modelKey)
        assertEquals("entry-1", row.entryId)
        assertArrayEquals("payload".toByteArray(), row.payload)
    }

    @Test
    fun `entry bytes with NUL and awkward characters are inboxed byte for byte`() = runBlocking {
        val c = authenticatedClient()
        val bytes = "a\u0000b\u0000 é 😀 \u2028\r\n".toByteArray() + byteArrayOf(0, 0, -1, 0x7F)
        val message = ClientMessage.newBuilder().setAppEntry(obscura.client.v1.appEntry {
            model = "m"; id = "e"; timestamp = 1; data = ByteString.copyFrom(bytes)
        }).build()

        c.receive(ClientMessage.parseFrom(message.toByteArray()))

        assertArrayEquals(bytes, c.inbox.peek().single().payload)
    }

    @Test
    fun `an unknown arm or blank AppEntry is acked and ignored without an inbox row`() = runBlocking {
        val c = authenticatedClient()
        val unknown = ClientMessage.newBuilder().setTimestamp(5).build()

        c.receive(unknown)

        assertTrue(c.inbox.peek().isEmpty())
        assertNull(c.messageReceived.tryReceive().getOrNull())
    }

    @Test
    fun `the wake-up stream keeps the newest 100`() = runBlocking {
        val c = authenticatedClient()
        repeat(101) { c.receive(appEntry("e$it", model = "m$it"), envelopeId = "env-$it") }

        val keys = generateSequence { c.messageReceived.tryReceive().getOrNull() }.toList()
        assertEquals((1..100).map { "m$it" }, keys)
    }

    // ── Friends ───────────────────────────────────────────────

    @Test
    fun `a request from a stranger is stored as pending with its username`() = runBlocking {
        val c = authenticatedClient()
        c.receive(friendRequest("alice"))
        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_RECEIVED)), c.getFriends())
        assertEquals(0L, c.inbox.depth())
    }

    @Test
    fun `a request from a known peer changes neither name nor status`() = runBlocking {
        val c = authenticatedClient()
        c.receive(friendRequest("alice"), envelopeId = "env-1")
        c.receive(friendRequest("mallory"), envelopeId = "env-2")
        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_RECEIVED)), c.getFriends())
    }

    @Test
    fun `an unsolicited accept is ignored`() = runBlocking {
        val c = authenticatedClient()
        c.receive(friendAccept())
        assertEquals(emptyList<FriendData>(), c.getFriends())

        c.receive(friendRequest("alice"), envelopeId = "env-2")
        c.receive(friendAccept(), envelopeId = "env-3")
        assertEquals(FriendStatus.PENDING_RECEIVED, c.getFriends().single().status)
    }

    @Test
    fun `an accepted peer cannot rename itself or regress its friendship`() = runBlocking {
        val c = authenticatedClient()
        c.db.friendQueries.insert(peer, "alice", FriendStatus.ACCEPTED.value)
        assertTrue(runCatching { c.receive(friendRequest("mallory")) }.exceptionOrNull() is ObscuraError.SendFailed)
        c.receive(friendAccept(), envelopeId = "env-2")
        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.ACCEPTED)), c.getFriends())
    }

    @Test
    fun `removing a friend forgets the friendship and its devices`() = runBlocking {
        val c = authenticatedClient()
        c.receive(friendRequest("alice"))
        c.devices.replace(peer, listOf(peerDevice))

        c.removeFriend(peer)

        assertEquals(emptyList<FriendData>(), c.getFriends())
        assertEquals(emptyList<String>(), c.devices.devicesOf(peer))
    }

    @Test
    fun `friendsChanged emits on collection and after a change`() = runBlocking {
        val c = authenticatedClient()
        val changes = Channel<Unit>(Channel.UNLIMITED)
        val collector = launch(Dispatchers.Default) { c.friendsChanged.collect { changes.send(it) } }

        withTimeout(5_000) { changes.receive() }
        c.receive(friendRequest("alice"))
        withTimeout(5_000) { changes.receive() }

        collector.cancel()
    }

    // ── Typing ────────────────────────────────────────────────

    @Test
    fun `typing is reported by user id, once per user, sorted, until stopped`() = runBlocking {
        val c = authenticatedClient()
        val other = "019f025a-0000-7de6-84b6-000000000000"
        c.receive(typing("thread", Client.TypingState.TYPING_STATE_STARTED), device = "phone")
        c.receive(typing("thread", Client.TypingState.TYPING_STATE_STARTED), device = "laptop")
        c.route(typing("thread", Client.TypingState.TYPING_STATE_STARTED), other, "other-phone", "env-x")

        assertEquals(listOf(other, peer), c.observeTyping("thread").first())

        c.receive(typing("thread", Client.TypingState.TYPING_STATE_STOPPED), device = "phone")
        c.receive(typing("thread", Client.TypingState.TYPING_STATE_STOPPED), device = "laptop")
        assertEquals(listOf(other), c.observeTyping("thread").first())
        assertEquals(0L, c.inbox.depth())
    }

    @Test
    fun `an unspecified typing state or blank context is ignored`() = runBlocking {
        val c = authenticatedClient()
        c.receive(typing("thread", Client.TypingState.TYPING_STATE_UNSPECIFIED))
        c.receive(typing(" ", Client.TypingState.TYPING_STATE_STARTED))
        assertEquals(emptyList<String>(), c.observeTyping("thread").first())
        assertEquals(emptyList<String>(), c.observeTyping("thread").first())
    }
}
