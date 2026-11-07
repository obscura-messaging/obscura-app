package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.AttachmentUpload
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SELF_DEVICE_ID
import dev.barrelmaker.obscura.kit.SELF_USER_ID
import dev.barrelmaker.obscura.kit.authenticatedClient
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.generateIdentity
import dev.barrelmaker.obscura.kit.linking.HistorySync
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.sessionClient
import dev.barrelmaker.obscura.kit.storeLocalDevice
import dev.barrelmaker.obscura.kit.storedSession
import com.google.protobuf.ByteString
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import obscura.client.v1.Client.AttachmentPointer
import obscura.client.v1.Client.EntrySnapshot
import obscura.client.v1.Client.HistorySnapshot
import obscura.client.v1.Client.StoredMessageRecord
import obscura.client.v1.Client.StoredProfileRecord
import obscura.client.v1.Client.StoredStoryRecord
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

class ContentStoreTest {
    private lateinit var db: ObscuraDatabase
    private lateinit var store: ContentStore
    private val peer = "019f025a-0000-7de6-84b6-000000000002"

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        db = ObscuraDatabase(driver)
        store = ContentStore(db, driver)
    }

    @Test
    fun `expiresAt uses 30d ceiling when unseen and min of 30d or 15m after view`() {
        val sentAt = 1_000_000L
        assertEquals(sentAt + MAX_EPHEMERAL_AGE_MS, expiresAt(sentAt, null))
        assertEquals(sentAt + 5_000L + EXPIRE_AFTER_VIEW_MS, expiresAt(sentAt, sentAt + 5_000L))
        val nearEnd = sentAt + MAX_EPHEMERAL_AGE_MS - 1_000L
        assertEquals(sentAt + MAX_EPHEMERAL_AGE_MS, expiresAt(sentAt, nearEnd))
    }

    @Test
    fun `messages are ordered by sentAt ASC then id ASC`() = runBlocking {
        store.putConversation(ConversationItemData("dm_b", peer, "message", SELF_USER_ID, 100, null, expiresAt(100, null), "b"))
        store.putConversation(ConversationItemData("dm_a", peer, "message", SELF_USER_ID, 100, null, expiresAt(100, null), "a"))
        store.putConversation(ConversationItemData("dm_0", peer, "message", SELF_USER_ID, 50, null, expiresAt(50, null), "0"))

        assertEquals(listOf("dm_0", "dm_a", "dm_b"), store.getMessages().map { it.id })
    }

    @Test
    fun `sweepExpired records tombstones, returns purged media refs and touched models, and cleans old tombstones`() = runBlocking {
        val now = 1_000_000_000L
        val key = byteArrayOf(1, 2, 3)
        val nonce = byteArrayOf(4, 5, 6)
        store.putConversation(
            ConversationItem("dm_exp", peer, "message", peer, 100, 200, now - 1, "gone"),
        )
        store.putConversation(
            ConversationItem(
                "pix_exp", peer, "pix", peer, 100, 200, now, "",
                attachment = MediaAttachment("att_pix", key, nonce, "photo"),
                displayDuration = 5,
            ),
        )
        store.putConversation(
            ConversationItem("dm_keep", peer, "message", peer, now, null, now + 10_000, "keep"),
        )
        store.putStory(
            StoryItem(
                "st_exp", peer, 100, now - 5, "old story",
                attachment = MediaAttachment("att_story", key, nonce, "photo"),
            ),
        )
        store.putStory(
            StoryItem("st_keep", peer, now, now + STORY_MAX_AGE_MS, "fresh story"),
        )
        db.contentQueries.insertErased("ancient_tombstone", now - MAX_EPHEMERAL_AGE_MS)
        db.contentQueries.insertErased("recent_tombstone", now - 1_000)

        val outcome = store.sweepExpired(now)

        assertEquals(listOf("att_pix", "att_story"), outcome.purgedMediaRefs)
        assertEquals(listOf("directMessage", "pix", "story"), outcome.touchedModels)
        assertEquals(listOf("dm_keep"), store.getMessages().map { it.id })
        assertEquals(listOf("st_keep"), store.getStories(now).map { it.id })
        val canReinsertMsg = db.transactionWithResult { store.canInsertConversationInTransaction("dm_exp") }
        val canReinsertStory = db.transactionWithResult { store.canInsertStoryInTransaction("st_exp") }
        assertFalse(canReinsertMsg)
        assertFalse(canReinsertStory)
        assertFalse(db.contentQueries.existsErased("ancient_tombstone").executeAsOne())
        assertTrue(db.contentQueries.existsErased("recent_tombstone").executeAsOne())
    }

    @Test
    fun `MediaAttachment compares contentKey and nonce by value and normalizes blank mediaType`() {
        val a = MediaAttachment("att_1", byteArrayOf(1, 2, 3), byteArrayOf(4, 5))
        val b = MediaAttachment("att_1", byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "")
        val c = MediaAttachment("att_1", byteArrayOf(9, 2, 3), byteArrayOf(4, 5), "photo")
        assertEquals("photo", a.mediaType)
        assertEquals("photo", b.mediaType)
        assertTrue(a.equals(a))
        assertFalse(a.equals("not-an-attachment"))
        assertFalse(a.equals(null))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        assertNotEquals(a, c)
        assertNotEquals(a, MediaAttachment("att_2", byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "photo"))
        assertNotEquals(a, MediaAttachment("att_1", byteArrayOf(1, 2, 3), byteArrayOf(9, 5), "photo"))
        assertNotEquals(a, MediaAttachment("att_1", byteArrayOf(1, 2, 3), byteArrayOf(4, 5), "video"))
    }

    @Test
    fun `ConversationItem enforces kind and pix invariants`() {
        val att = MediaAttachment("att_1", byteArrayOf(1), byteArrayOf(2))
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "story", peer, 100L, null, content = "x")
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "pix", peer, 100L, null, content = "", attachment = null)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "message", peer, 100L, null, content = "x", attachment = att)
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "message", peer, 100L, null, content = "x", caption = "cap")
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "message", peer, 100L, null, content = "x", captionMeta = "{}")
        }
        assertThrows(IllegalArgumentException::class.java) {
            ConversationItem("id", peer, "message", peer, 100L, null, content = "x", displayDuration = 5)
        }
        val defaultPix = ConversationItem.pix("pix_def", peer, peer, 100L, att)
        assertEquals(expiresAt(100L, null), defaultPix.expiresAt)
        assertEquals(0, defaultPix.displayDuration)
        assertFalse(defaultPix.undelivered)
        val undeliveredPix = ConversationItem.pix("pix_u", peer, peer, 100L, att, undelivered = true)
        assertTrue(undeliveredPix.undelivered)
    }

    @Test
    fun `HistorySync exports null when empty and round-trips messages pix stories and profiles while skipping invalid records`() = runBlocking {
        assertNull(HistorySync.exportSnapshot(store))
        assertNull(HistorySync.uploadHistorySnapshot(store) { error("should not upload empty snapshot") })

        // Export when only profiles is non-empty
        val profile = ProfileItem(peer, "dev_1", 500L, "Bob", "Hello")
        store.putProfile(profile)
        assertNotNull(HistorySync.exportSnapshot(store))

        // Export when only stories is non-empty
        val storyOnlyDriver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(ObscuraDatabase.Schema::create)
        val storyOnlyStore = ContentStore(ObscuraDatabase(storyOnlyDriver), storyOnlyDriver)
        storyOnlyStore.putStory(StoryItem("st_only", peer, 100L, 100L + STORY_MAX_AGE_MS, "only story"))
        assertNotNull(HistorySync.exportSnapshot(storyOnlyStore))

        // Populate messages (plain message, pix with caption/meta/viewedAt, pix without caption/meta/viewedAt) and stories (with and without attachment/meta)
        val att1 = MediaAttachment("att_pix_1", byteArrayOf(1, 2), byteArrayOf(3, 4), "photo")
        val att2 = MediaAttachment("att_pix_2", byteArrayOf(5, 6), byteArrayOf(7, 8), "video")
        val attStory = MediaAttachment("att_st_1", byteArrayOf(9, 10), byteArrayOf(11, 12), "photo")
        val msgPlain = ConversationItem("dm_1", peer, "message", SELF_USER_ID, 100L, null, expiresAt(100L, null), "hello")
        val pixFull = ConversationItem(
            "pix_1", peer, "pix", peer, 200L, 250L, expiresAt(200L, 250L), "",
            attachment = att1, caption = "cap", captionMeta = """{"y":0.5}""", displayDuration = 7,
        )
        val pixBare = ConversationItem(
            "pix_2", peer, "pix", peer, 300L, null, expiresAt(300L, null), "",
            attachment = att2, caption = null, captionMeta = null, displayDuration = 5,
        )
        val storyFull = StoryItem(
            "st_1", peer, 400L, 400L + STORY_MAX_AGE_MS, "caption",
            attachment = attStory, captionMeta = """{"y":0.25}""",
        )
        val storyBare = StoryItem("st_2", peer, 450L, 450L + STORY_MAX_AGE_MS, "bare story", attachment = null, captionMeta = null)

        store.putConversation(msgPlain)
        store.putConversation(pixFull)
        store.putConversation(pixBare)
        store.putStory(storyFull)
        store.putStory(storyBare)

        var uploadedBytes = byteArrayOf()
        val pointer = HistorySync.uploadHistorySnapshot(store) { bytes ->
            uploadedBytes = bytes
            AttachmentUpload("att_hist", byteArrayOf(1, 2, 3), byteArrayOf(4, 5, 6))
        }
        assertNotNull(pointer)

        // Append invalid records to the snapshot and import into a fresh store
        val exported = EntrySnapshot.parseFrom(uploadedBytes).toBuilder()
            .addMessages(StoredMessageRecord.newBuilder().setId(" ").setPeerUserId(peer).setAuthorUserId(peer).setKind("message"))
            .addMessages(StoredMessageRecord.newBuilder().setId("dm_no_peer").setPeerUserId(" ").setAuthorUserId(peer).setKind("message"))
            .addMessages(StoredMessageRecord.newBuilder().setId("dm_no_author").setPeerUserId(peer).setAuthorUserId(" ").setKind("message"))
            .addMessages(
                StoredMessageRecord.newBuilder()
                    .setId("dm_empty_kind")
                    .setPeerUserId(peer)
                    .setAuthorUserId(peer)
                    .setSentAt(120L)
                    .setContent("default kind"),
            )
            .addMessages(
                StoredMessageRecord.newBuilder()
                    .setId("pix_no_att")
                    .setPeerUserId(peer)
                    .setKind("pix")
                    .setAuthorUserId(peer)
                    .setSentAt(340L),
            )
            .addMessages(
                StoredMessageRecord.newBuilder()
                    .setId("pix_bad_att")
                    .setPeerUserId(peer)
                    .setKind("pix")
                    .setAuthorUserId(peer)
                    .setSentAt(350L)
                    .setAttachment(AttachmentPointer.newBuilder().setId(" ")),
            )
            .addMessages(
                StoredMessageRecord.newBuilder()
                    .setId("pix_empty_key")
                    .setPeerUserId(peer)
                    .setKind("pix")
                    .setAuthorUserId(peer)
                    .setSentAt(360L)
                    .setAttachment(AttachmentPointer.newBuilder().setId("att_k").setNonce(ByteString.copyFrom(byteArrayOf(1)))),
            )
            .addMessages(
                StoredMessageRecord.newBuilder()
                    .setId("pix_empty_nonce")
                    .setPeerUserId(peer)
                    .setKind("pix")
                    .setAuthorUserId(peer)
                    .setSentAt(370L)
                    .setAttachment(AttachmentPointer.newBuilder().setId("att_n").setContentKey(ByteString.copyFrom(byteArrayOf(1)))),
            )
            .addStories(StoredStoryRecord.newBuilder().setId("").setAuthorUserId(peer))
            .addStories(StoredStoryRecord.newBuilder().setId("st_no_author").setAuthorUserId(" "))
            .addProfiles(StoredProfileRecord.newBuilder().setUserId(" ").setAuthorDeviceId("dev"))
            .build()

        val targetDriver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(ObscuraDatabase.Schema::create)
        val targetStore = ContentStore(ObscuraDatabase(targetDriver), targetDriver)
        HistorySync.importSnapshot(exported, targetStore)
        // Re-importing is idempotent and exercises existing-ID skips in ContentStore.importSnapshot
        HistorySync.importSnapshot(exported, targetStore)

        val importedMsgs = targetStore.getMessages().associateBy { it.id }
        assertEquals(msgPlain, importedMsgs["dm_1"])
        assertEquals("message", importedMsgs["dm_empty_kind"]?.kind)
        assertEquals(pixFull, importedMsgs["pix_1"])
        assertEquals(pixBare, importedMsgs["pix_2"])
        assertFalse(importedMsgs.containsKey("pix_no_att"))
        assertFalse(importedMsgs.containsKey("pix_bad_att"))
        assertFalse(importedMsgs.containsKey("pix_empty_key"))
        assertFalse(importedMsgs.containsKey("pix_empty_nonce"))
        assertFalse(importedMsgs.containsKey(" "))
        assertFalse(importedMsgs.containsKey("dm_no_peer"))
        assertFalse(importedMsgs.containsKey("dm_no_author"))

        val importedStories = targetStore.getAllStories().associateBy { it.id }
        assertEquals(listOf(storyFull, storyBare), listOf(importedStories["st_1"], importedStories["st_2"]))
        assertEquals(listOf(profile), targetStore.getProfiles())

        // Corrupt snapshot bytes throw ProtocolViolation on restoreHistorySnapshot
        assertThrows(ObscuraError.ProtocolViolation::class.java) {
            runBlocking {
                HistorySync.restoreHistorySnapshot(pointer!!, targetStore) { _, _, _ -> byteArrayOf(-1, -1, -1) }
            }
        }

        // MediaAttachment.fromProto defaults empty mediaType to "photo"
        val decodedDefaultType = MediaAttachment.fromProto(
            AttachmentPointer.newBuilder()
                .setId("att_default")
                .setContentKey(ByteString.copyFrom(byteArrayOf(1)))
                .setNonce(ByteString.copyFrom(byteArrayOf(2)))
                .setMediaType("")
                .build(),
        )
        assertEquals("photo", decodedDefaultType?.mediaType)

        // ContentStore profile upsert when newer timestamp wins, raw attachment edge cases, and envelope check failure
        assertTrue(
            targetStore.upsertProfileIfNewerInTransaction(
                ProfileItem(peer, "dev_0", 999L, "Bob Newer", "New Bio"),
            ),
        )
        db.contentQueries.insertStory("st_no_key", peer, 10L, 100L, "c", "ref", null, byteArrayOf(1), "photo", null, 0L)
        db.contentQueries.insertStory("st_no_nonce", peer, 10L, 100L, "c", "ref", byteArrayOf(1), null, "photo", null, 0L)
        db.contentQueries.insertStory("st_null_type", peer, 10L, 100L, "c", "ref", byteArrayOf(1), byteArrayOf(2), null, null, 0L)
        db.contentQueries.insertStory("st_empty_type", peer, 10L, 100L, "c", "ref", byteArrayOf(1), byteArrayOf(2), "", null, 0L)
        db.contentQueries.insertStory("st_blank_ref", peer, 10L, 100L, "c", " ", byteArrayOf(1), byteArrayOf(2), "photo", null, 0L)
        val rawStories = store.getAllStories().associateBy { it.id }
        assertNull(rawStories["st_no_key"]?.attachment)
        assertNull(rawStories["st_no_nonce"]?.attachment)
        assertNull(rawStories["st_blank_ref"]?.attachment)
        assertEquals("photo", rawStories["st_null_type"]?.attachment?.mediaType)
        assertEquals("photo", rawStories["st_empty_type"]?.attachment?.mediaType)

        targetDriver.execute(
            null,
            "CREATE TRIGGER drop_env AFTER INSERT ON ProcessedEnvelope BEGIN DELETE FROM ProcessedEnvelope WHERE envelope_id = NEW.envelope_id; END",
            0,
        )
        assertThrows(IllegalStateException::class.java) {
            targetStore.recordEnvelopeInTransaction("env_missing")
        }
        Unit
    }

    @Test
    fun `swept content is not recoverable from the database or its WAL`() = runBlocking {
        val dir = File("build/test-databases/sweep-${UUID.randomUUID()}").also { it.mkdirs() }
        val path = File(dir, "sweep.db")
        val driver = JdbcSqliteDriver("jdbc:sqlite:${path.absolutePath}")
        ObscuraDatabase.Schema.create(driver)
        driver.pragma("PRAGMA journal_mode = WAL")
        val fileStore = ContentStore(ObscuraDatabase(driver), driver)
        val secrets = listOf("ERASE-ME-7f3a9c", "ERASE-ME-2b8d41")
        fun onDisk(secret: String): Boolean = listOf(path, File("${path.absolutePath}-wal"))
            .filter { it.exists() }
            .any { String(it.readBytes(), Charsets.ISO_8859_1).contains(secret) }

        fileStore.putConversation(ConversationItemData("dm_0", peer, "message", peer, 1, null, 10, secrets[0]))
        fileStore.putStory(StoryItemData("st_0", peer, 1, 10, secrets[1]))
        assertTrue(secrets.all(::onDisk))

        fileStore.sweepExpired(now = 20)

        assertFalse(secrets.any(::onDisk))
        driver.close()
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun `sendMessage sendPix postStory updateProfile markSeen and flushOutbox enforce audience and outbox rules`() = runBlocking {
        MockWebServer().use { server ->
            FakeObscuraServer().use { peers ->
                val remote = peers.register(peer)
                var allowSend = false
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse = when (request.url.encodedPath) {
                        "/v1/keys/$peer" -> MockResponse.Builder()
                            .body(JSONObject().put("bundles", JSONArray().put(remote.consumeBundle())).toString())
                            .build()
                        "/v1/messages" -> if (allowSend) {
                            MockResponse.Builder().body("").build()
                        } else {
                            MockResponse.Builder().code(500).body("offline").build()
                        }
                        else -> MockResponse.Builder().code(404).build()
                    }
                }
                server.start()
                val c = sessionClient(server.url("/").toString().trimEnd('/'), storedSession())
                assertTrue(c.auth.restore())

                // Sending to a non-friend stores locally with undelivered = true and throws SendFailed
                assertTrue(runCatching { c.sendMessage(peer, "hello") }.exceptionOrNull() is ObscuraError.SendFailed)
                assertTrue(c.getMessages().single().undelivered)

                // When there are no accepted friends, postStory and updateProfile succeed locally and flushOutbox marks them delivered
                val stNoPeers = c.postStory("solo story", null, null, null, null, null)
                c.content.setStoryUndelivered(stNoPeers, true)
                c.updateProfile("Solo", "Bio")
                c.content.setProfileUndelivered(SELF_USER_ID, c.getProfiles().single().updatedAt, true)
                assertEquals(2, c.flushOutbox())

                // Become accepted friend, but server is still failing (allowSend = false)
                c.db.friendQueries.insert(peer, "bob", FriendStatus.ACCEPTED.value)
                val keyB64 = ByteArray(32) { 1 }.toBase64()
                val nonceB64 = ByteArray(12) { 2 }.toBase64()
                assertTrue(
                    runCatching {
                        c.sendPix(peer, "att_1", keyB64, nonceB64, "photo", "", """{"y":0.5}""", 5)
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(
                    runCatching {
                        c.sendPix(peer, "att_1b", keyB64, nonceB64, "photo", "caption", "", 5)
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(
                    runCatching {
                        c.postStory("story 1", "att_2", keyB64, nonceB64, null, """{"y":0.2}""")
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(
                    runCatching {
                        c.postStory("story text only", null, null, null, null, "")
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(runCatching { c.updateProfile("Alice", "Bio") }.exceptionOrNull() is ObscuraError.SendFailed)
                assertTrue(runCatching { c.updateProfile("Alice 2", "Bio 2") }.exceptionOrNull() is ObscuraError.SendFailed)

                // Also put an undelivered message to a non-friend so flushOutbox skips it
                c.content.putConversation(
                    ConversationItem.message("stranger_dm", "019f025a-0000-7de6-84b6-000000000099", SELF_USER_ID, 50, "skip", undelivered = true),
                )

                assertEquals(4, c.content.getUndeliveredMessages().size)
                assertEquals(2, c.content.getUndeliveredStories().size)
                assertEquals(1, c.content.getUndeliveredProfiles().size)

                // While server is still failing, flushOutbox delivers 0 items
                assertEquals(0, c.flushOutbox())

                // Now server accepts messages; flushOutbox delivers the 6 items addressed to accepted friends
                allowSend = true
                assertEquals(6, c.flushOutbox())
                assertEquals(listOf("stranger_dm"), c.content.getUndeliveredMessages().map { it.id })
                assertTrue(c.content.getUndeliveredStories().isEmpty())
                assertTrue(c.content.getUndeliveredProfiles().isEmpty())

                // Direct sendPix, postStory, updateProfile, and sendTyping when server accepts
                c.sendPix(peer, "att_ok", keyB64, nonceB64, "", "hi", null, 5)
                c.postStory("story ok", "att_st_ok", keyB64, nonceB64, "photo", null)
                c.updateProfile("Alice 3", "Bio 3")
                c.sendTyping(peer, dev.barrelmaker.obscura.kit.TypingState.STARTED)
                // Second sendTyping within 2s is throttled
                c.sendTyping(peer, dev.barrelmaker.obscura.kit.TypingState.STARTED)
                assertEquals(setOf("directMessage"), c.sweepExpired())

                // Incoming message from peer can be marked seen once; missing or own messages are ignored
                c.markSeen("non_existent_id")
                c.markSeen(c.getMessages().first { it.authorUserId == SELF_USER_ID }.id)
                c.content.putConversation(
                    ConversationItemData("in_1", peer, "message", peer, 500, null, expiresAt(500, null), "from peer"),
                )
                c.markSeen("in_1")
                val seenRow = c.getMessages().first { it.id == "in_1" }
                assertNotNull(seenRow.viewedAt)
                assertEquals(expiresAt(500, seenRow.viewedAt), seenRow.expiresAt)
                c.markSeen("in_1")

                c.auth.end()
                Unit
            }
        }
    }

    @Test
    fun `invalid arguments to sendMessage sendPix postStory and markSeen fail before network`() = runBlocking {
        val c = authenticatedClient()
        val validB64 = ByteArray(16) { 1 }.toBase64()
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.sendMessage(" ", "hi") } }
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.sendMessage(SELF_USER_ID, "hi") } }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(" ", "att", validB64, validB64, "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(SELF_USER_ID, "att", validB64, validB64, "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "", validB64, validB64, "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "att", " ", validB64, "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "att", validB64, " ", "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "att", "not-base64!", validB64, "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "att", validB64, "not-base64!", "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.postStory("text", "att", null, validB64, "photo", null) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.postStory("text", "att", "not-base64!", validB64, "photo", null) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.postStory("text", "att", validB64, null, "photo", null) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.postStory("text", "att", validB64, "not-base64!", "photo", null) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.markSeen(" ") } }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.downloadAttachmentToCache("att", validB64, validB64) }
        }
        Unit
    }

    @Test
    fun `uploadAttachmentFile downloadAttachmentToCache and sweepExpired cache purge work end to end`() = runBlocking {
        val dir = File("build/test-databases/cache-${UUID.randomUUID()}").also { it.mkdirs() }
        val cacheDir = File(dir, "attachments")
        val srcFile = File(dir, "input.jpg").apply { writeBytes("image-bytes".toByteArray()) }
        val attachments = mutableMapOf<String, ByteArray>()
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.url.encodedPath
                    return when {
                        path == "/v1/attachments" && request.method == "POST" -> {
                            val id = "att_cached_1"
                            attachments[id] = request.body!!.toByteArray()
                            MockResponse.Builder().body(JSONObject().put("id", id).toString()).build()
                        }
                        path.startsWith("/v1/attachments/") -> {
                            val id = path.removePrefix("/v1/attachments/")
                            attachments[id]?.let { MockResponse.Builder().body(okio.Buffer().write(it)).build() }
                                ?: MockResponse.Builder().code(404).build()
                        }
                        else -> MockResponse.Builder().code(404).build()
                    }
                }
            }
            server.start()
            val apiUrl = server.url("/").toString().trimEnd('/')
            val c = ObscuraClient(
                ObscuraConfig(apiUrl, "Test"),
                driver = null,
                sessionStorage = storedSession(),
                attachmentCacheDir = cacheDir,
            ).also {
                it.signalStore.generateIdentity()
                it.storeLocalDevice()
            }
            assertTrue(c.auth.restore())

            val uploaded = c.uploadAttachmentFile(srcFile)
            assertEquals("att_cached_1", uploaded.id)

            assertThrows(ObscuraError.InvalidArgument::class.java) {
                runBlocking { c.downloadAttachmentToCache("uncached", "not-base64!", uploaded.nonce.toBase64()) }
            }
            assertThrows(ObscuraError.InvalidArgument::class.java) {
                runBlocking { c.downloadAttachmentToCache("uncached", uploaded.contentKey.toBase64(), "not-base64!") }
            }

            val downloaded1 = c.downloadAttachmentToCache(
                uploaded.id,
                uploaded.contentKey.toBase64(),
                uploaded.nonce.toBase64(),
            )
            assertTrue(downloaded1.exists())
            assertArrayEquals("image-bytes".toByteArray(), downloaded1.readBytes())

            // Second call hits cache even when server attachment is removed
            attachments.clear()
            val downloaded2 = c.downloadAttachmentToCache(
                uploaded.id,
                uploaded.contentKey.toBase64(),
                uploaded.nonce.toBase64(),
            )
            assertEquals(downloaded1.absolutePath, downloaded2.absolutePath)

            // Store an expired pix referencing uploaded.id and sweep via ObscuraClient
            val now = 5_000_000L
            c.content.putConversation(
                ConversationItem(
                    "pix_exp", peer, "pix", peer, 100, 200, now - 1, "",
                    attachment = MediaAttachment(uploaded.id, uploaded.contentKey, uploaded.nonce, "photo"),
                    displayDuration = 5,
                ),
            )
            val touched = c.sweepExpired(now)
            assertEquals(setOf("pix"), touched)
            assertFalse(downloaded1.exists(), "sweepExpired must purge cached attachment file")

            // Write another cached attachment and verify wipeDevice purges attachmentCacheDir
            val extraCached = dev.barrelmaker.obscura.kit.crypto.AttachmentCrypto.writeCached(cacheDir, "att_wipe", "image-bytes".toByteArray())
            assertTrue(extraCached.exists())
            c.wipeDevice()
            assertFalse(extraCached.exists(), "wipeDevice must purge all cached attachment files")
        }
        dir.deleteRecursively()
        Unit
    }
}
