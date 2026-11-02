package dev.barrelmaker.obscura.kit

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import obscura.client.v1.Client
import obscura.client.v1.Client.AttachmentPointer
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import obscura.client.v1.Client.PixMessage
import obscura.client.v1.Client.ProfileUpdate
import obscura.client.v1.Client.SeenReceipt
import obscura.client.v1.Client.StoryPost
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** [ObscuraClient.route] with hand-built decrypted messages: what each arm stores and announces. */
class ReceivePathTest {
    private val peer = "019f025a-0000-7de6-84b6-000000000002"
    private val peerDevice = "019f025a-0000-7de6-84b6-0000000000d2"
    private val thirdParty = "019f025a-0000-7de6-84b6-000000000003"

    private fun directMessage(
        id: String,
        content: String = "payload",
        peerUserId: String = "",
        timestamp: Long = 1_700_000_000_000,
    ) = ClientMessage.newBuilder()
        .setTimestamp(timestamp)
        .setDirectMessage(
            DirectMessage.newBuilder()
                .setId(id)
                .setPeerUserId(peerUserId)
                .setContent(content),
        )
        .build()

    private fun pixMessage(
        id: String,
        peerUserId: String = "",
        mediaRef: String = "att_1",
        contentKey: ByteArray = ByteArray(32) { 1 },
        nonce: ByteArray = ByteArray(12) { 2 },
        mediaType: String = "photo",
        caption: String = "look",
        captionMeta: String = """{"style":"bar"}""",
        displayDuration: Int = 5,
        timestamp: Long = 1_700_000_000_000,
    ) = ClientMessage.newBuilder()
        .setTimestamp(timestamp)
        .setPix(
            PixMessage.newBuilder()
                .setId(id)
                .setPeerUserId(peerUserId)
                .setAttachment(
                    AttachmentPointer.newBuilder()
                        .setId(mediaRef)
                        .setContentKey(ByteString.copyFrom(contentKey))
                        .setNonce(ByteString.copyFrom(nonce))
                        .setMediaType(mediaType),
                )
                .setCaption(caption)
                .setCaptionMeta(captionMeta)
                .setDisplayDurationSecs(displayDuration),
        )
        .build()

    private fun seenReceipt(
        entryId: String,
        viewedAt: Long = 1_700_000_000_500,
        peerUserId: String = "",
        timestamp: Long = 1_700_000_000_600,
    ) = ClientMessage.newBuilder()
        .setTimestamp(timestamp)
        .setSeenReceipt(
            SeenReceipt.newBuilder()
                .setEntryId(entryId)
                .setPeerUserId(peerUserId)
                .setViewedAt(viewedAt),
        )
        .build()

    private fun storyPost(
        id: String,
        content: String = "story text",
        mediaRef: String? = null,
        timestamp: Long = 1_700_000_000_000,
    ) = ClientMessage.newBuilder()
        .setTimestamp(timestamp)
        .setStory(
            StoryPost.newBuilder()
                .setId(id)
                .setContent(content)
                .apply {
                    if (mediaRef != null) {
                        setAttachment(
                            AttachmentPointer.newBuilder()
                                .setId(mediaRef)
                                .setContentKey(ByteString.copyFrom(ByteArray(32) { 3 }))
                                .setNonce(ByteString.copyFrom(ByteArray(12) { 4 }))
                                .setMediaType("photo"),
                        )
                    }
                },
        )
        .build()

    private fun profileUpdate(displayName: String, bio: String = "", timestamp: Long = 1_700_000_000_000) =
        ClientMessage.newBuilder()
            .setTimestamp(timestamp)
            .setProfile(ProfileUpdate.newBuilder().setDisplayName(displayName).setBio(bio))
            .build()

    private fun friendRequest(username: String) = ClientMessage.newBuilder()
        .setFriendRequest(obscura.client.v1.friendRequest { this.username = username }).build()

    private fun friendAccept() = ClientMessage.newBuilder().setFriendAccept(obscura.client.v1.friendAccept {}).build()

    private fun typing(contextId: String, state: Client.TypingState) = ClientMessage.newBuilder()
        .setTypingSignal(obscura.client.v1.typingSignal {
            this.contextId = contextId
            this.state = state
        }).build()

    private suspend fun ObscuraClient.receive(
        message: ClientMessage,
        envelopeId: String = "env-1",
        sender: String = peer,
        device: String = peerDevice,
    ) = route(message, sender, device, envelopeId)

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
        c.receive(directMessage("e", timestamp = Long.MAX_VALUE))
        assertTrue(c.getMessages().single().sentAt <= System.currentTimeMillis() + 60_000L)
    }

    // ── Content arms ──────────────────────────────────────────

    @Test
    fun `a new entry is stored and announced once, a redelivery or duplicate id neither`() = runBlocking {
        val c = authenticatedClient()

        c.receive(directMessage("entry-1", content = "first"), envelopeId = "env-1")
        c.receive(directMessage("entry-1", content = "redelivered"), envelopeId = "env-1")
        c.receive(directMessage("entry-1", content = "replayed-id"), envelopeId = "env-2")

        val stored = c.getMessages().single()
        assertEquals("first", stored.content)
        assertEquals(peer, stored.authorUserId)
        assertEquals(peer, stored.peerUserId)
        assertEquals("directMessage", c.messageReceived.tryReceive().getOrNull())
        assertNull(c.messageReceived.tryReceive().getOrNull())
    }

    @Test
    fun `self-synced direct message uses claimed peerUserId and rejects missing or third-party spoofing`() = runBlocking {
        val c = authenticatedClient()

        c.receive(directMessage("dm_self", content = "synced", peerUserId = peer), envelopeId = "e1", sender = SELF_USER_ID)
        c.receive(directMessage("dm_blank_peer", content = "ignored", peerUserId = ""), envelopeId = "e2", sender = SELF_USER_ID)
        c.receive(directMessage("dm_self_peer", content = "ignored", peerUserId = SELF_USER_ID), envelopeId = "e3", sender = SELF_USER_ID)
        c.receive(directMessage("dm_spoof", content = "spoofed", peerUserId = thirdParty), envelopeId = "e4", sender = peer)

        val stored = c.getMessages().single()
        assertEquals("dm_self", stored.id)
        assertEquals(peer, stored.peerUserId)
        assertEquals(SELF_USER_ID, stored.authorUserId)
    }

    @Test
    fun `pix is stored with base64 attachment fields and seen receipt updates viewedAt and expiresAt`() = runBlocking {
        val c = authenticatedClient()
        val key = ByteArray(32) { 7 }
        val nonce = ByteArray(12) { 8 }
        c.receive(pixMessage("pix_1", contentKey = key, nonce = nonce, timestamp = 1_000L), envelopeId = "e1")
        assertEquals("pix", c.messageReceived.tryReceive().getOrNull())

        val beforeSeen = c.getMessages().single()
        assertEquals("pix", beforeSeen.kind)
        assertEquals(key.toBase64(), beforeSeen.contentKey)
        assertEquals(nonce.toBase64(), beforeSeen.nonce)
        assertNull(beforeSeen.viewedAt)
        assertEquals(1_000L + MAX_EPHEMERAL_AGE_MS, beforeSeen.expiresAt)

        // Author cannot mark their own pix as seen
        c.receive(seenReceipt("pix_1", viewedAt = 1_500L, timestamp = 1_600L), envelopeId = "e2", sender = peer)
        assertNull(c.getMessages().single().viewedAt)

        // Self-synced seen receipt from another own device marks peer's pix as seen and caps viewedAt at sentAt
        c.receive(
            seenReceipt("pix_1", viewedAt = 9_999L, peerUserId = peer, timestamp = 2_000L),
            envelopeId = "e3",
            sender = SELF_USER_ID,
        )
        assertEquals("seen", c.messageReceived.tryReceive().getOrNull())
        val afterSeen = c.getMessages().single()
        assertEquals(2_000L, afterSeen.viewedAt)
        assertEquals(2_000L + EXPIRE_AFTER_VIEW_MS, afterSeen.expiresAt)
    }

    @Test
    fun `story and profile updates follow expiry and LWW tie-break rules`() = runBlocking {
        val c = authenticatedClient()
        val now = System.currentTimeMillis()
        c.receive(storyPost("st_1", "hello story", mediaRef = "att_s", timestamp = now), envelopeId = "e1")
        assertEquals("story", c.messageReceived.tryReceive().getOrNull())
        assertEquals(1, c.getStories(now = now + 1_000L).size)
        assertTrue(c.getStories(now = now + STORY_MAX_AGE_MS + 1L).isEmpty())

        c.receive(profileUpdate("Alice 1", "bio 1", timestamp = 1_000L), envelopeId = "e2", device = "dev_b")
        assertEquals("profile", c.messageReceived.tryReceive().getOrNull())
        // Older timestamp loses
        c.receive(profileUpdate("Stale", "old", timestamp = 900L), envelopeId = "e3", device = "dev_z")
        assertNull(c.messageReceived.tryReceive().getOrNull())
        // Same timestamp, lexicographically smaller device loses
        c.receive(profileUpdate("Tie Loser", "tie", timestamp = 1_000L), envelopeId = "e4", device = "dev_a")
        assertNull(c.messageReceived.tryReceive().getOrNull())
        // Same timestamp, lexicographically greater device wins
        c.receive(profileUpdate("Alice 2", "bio 2", timestamp = 1_000L), envelopeId = "e5", device = "dev_c")
        assertEquals("profile", c.messageReceived.tryReceive().getOrNull())

        val profile = c.getProfiles().single()
        assertEquals("Alice 2", profile.displayName)
        assertEquals("bio 2", profile.bio)
        assertEquals("dev_c", profile.authorDeviceId)
    }

    @Test
    fun `content with NUL and awkward characters is stored verbatim`() = runBlocking {
        val c = authenticatedClient()
        val text = "a\u0000b\u0000 é 😀 \u2028\r\n"
        val message = directMessage("e", content = text)

        c.receive(ClientMessage.parseFrom(message.toByteArray()))

        assertEquals(text, c.getMessages().single().content)
    }

    @Test
    fun `an unknown arm or blank id is acked and ignored`() = runBlocking {
        val c = authenticatedClient()
        c.receive(ClientMessage.newBuilder().setTimestamp(5).build(), envelopeId = "e1")
        c.receive(directMessage("", content = "blank"), envelopeId = "e2")

        assertTrue(c.getMessages().isEmpty())
        assertNull(c.messageReceived.tryReceive().getOrNull())
    }

    @Test
    fun `the wake-up stream keeps the newest 100`() = runBlocking {
        val c = authenticatedClient()
        repeat(101) {
            val msg = if (it % 2 == 0) directMessage("e$it") else storyPost("s$it")
            c.receive(msg, envelopeId = "env-$it")
        }

        val keys = generateSequence { c.messageReceived.tryReceive().getOrNull() }.toList()
        assertEquals(100, keys.size)
        assertEquals((1..100).map { if (it % 2 == 0) "directMessage" else "story" }, keys)
    }

    // ── Friends ───────────────────────────────────────────────

    @Test
    fun `a request from a stranger is stored as pending with its username`() = runBlocking {
        val c = authenticatedClient()
        c.receive(friendRequest("alice"))
        assertEquals(listOf(FriendData(peer, "alice", FriendStatus.PENDING_RECEIVED)), c.getFriends())
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
