package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SELF_DEVICE_ID
import dev.barrelmaker.obscura.kit.SELF_USER_ID
import dev.barrelmaker.obscura.kit.authenticatedClient
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.sessionClient
import dev.barrelmaker.obscura.kit.storedSession
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
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
        store.putConversation(
            ConversationItemData("dm_exp", peer, "message", peer, 100, 200, now - 1, "gone"),
        )
        store.putConversation(
            ConversationItemData(
                "pix_exp", peer, "pix", peer, 100, 200, now, "",
                mediaRef = "att_pix", contentKey = "k", nonce = "n", mediaType = "photo", displayDuration = 5,
            ),
        )
        store.putConversation(
            ConversationItemData("dm_keep", peer, "message", peer, now, null, now + 10_000, "keep"),
        )
        store.putStory(
            StoryItemData("st_exp", peer, 100, now - 5, "old story", mediaRef = "att_story", contentKey = "k", nonce = "n"),
        )
        store.putStory(
            StoryItemData("st_keep", peer, now, now + STORY_MAX_AGE_MS, "fresh story"),
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

                // Become accepted friend, but server is still failing (allowSend = false)
                c.db.friendQueries.insert(peer, "bob", FriendStatus.ACCEPTED.value)
                val keyB64 = ByteArray(32) { 1 }.toBase64()
                val nonceB64 = ByteArray(12) { 2 }.toBase64()
                assertTrue(
                    runCatching {
                        c.sendPix(peer, "att_1", keyB64, nonceB64, "photo", "cap", null, 5)
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(
                    runCatching {
                        c.postStory("story 1", "att_2", keyB64, nonceB64, "photo", null)
                    }.exceptionOrNull() is ObscuraError.SendFailed,
                )
                assertTrue(runCatching { c.updateProfile("Alice", "Bio") }.exceptionOrNull() is ObscuraError.SendFailed)

                assertEquals(2, c.content.getUndeliveredMessages().size)
                assertEquals(1, c.content.getUndeliveredStories().size)
                assertEquals(1, c.content.getUndeliveredProfiles().size)

                // Now server accepts messages; flushOutbox delivers all 4
                allowSend = true
                assertEquals(4, c.flushOutbox())
                assertTrue(c.content.getUndeliveredMessages().isEmpty())
                assertTrue(c.content.getUndeliveredStories().isEmpty())
                assertTrue(c.content.getUndeliveredProfiles().isEmpty())

                // Incoming message from peer can be marked seen once
                c.content.putConversation(
                    ConversationItemData("in_1", peer, "message", peer, 500, null, expiresAt(500, null), "from peer"),
                )
                c.markSeen("in_1")
                val seenRow = c.getMessages().first { it.id == "in_1" }
                assertNotNull(seenRow.viewedAt)
                assertEquals(expiresAt(500, seenRow.viewedAt), seenRow.expiresAt)

                c.auth.end()
                Unit
            }
        }
    }

    @Test
    fun `invalid arguments to sendMessage sendPix postStory and markSeen fail before network`() = runBlocking {
        val c = authenticatedClient()
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.sendMessage(" ", "hi") } }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(" ", "att", "k", "n", "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "", "k", "n", "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendPix(peer, "att", "not-base64!", "n", "photo", "", null, 5) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.postStory("text", "att", null, "n", "photo", null) }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) { runBlocking { c.markSeen(" ") } }
        Unit
    }
}
