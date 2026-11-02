package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File

class EntryStoreTest {

    private lateinit var store: EntryStore

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        store = EntryStore(ObscuraDatabase(driver), driver)
    }

    private fun entry(
        id: String,
        data: String = """{"content":"hi"}""",
        sentAt: Long = 1_000,
        user: String = "user_a",
        device: String = "device_a",
        localMetadata: String? = null,
    ) = StoredEntry(
        id = id,
        data = data,
        sentAt = sentAt,
        authorUserId = user,
        authorDeviceId = device,
        localMetadata = localMetadata,
    )

    @Test
    fun `data and metadata with NUL and awkward characters round-trip exactly, through export and import too`() = runBlocking {
        val awkward = "a\u0000b\u0000\u0000 \r\n\t\\\"' \u2028\u2029 \uFEFF é 😀 \u0001\u001F end\u0000"
        store.put("m", entry("e", data = awkward, localMetadata = awkward))

        val stored = store.get("m", listOf("e")).single()
        assertEquals(awkward, stored.data)
        assertEquals(awkward, stored.localMetadata)
        assertEquals(awkward.length, stored.data.length)

        val exported = store.export()
        assertEquals(awkward, exported.single().second.data)
        store.erase("m", listOf("e"))
        store.import(exported)
        assertEquals(awkward, store.all("m").single().data)
    }

    @Test
    fun `put then all returns what was written`() = runBlocking {
        store.put("directMessage", entry("dm_1"))

        val all = store.all("directMessage")

        assertEquals(1, all.size)
        assertEquals("dm_1", all[0].id)
        assertEquals("""{"content":"hi"}""", all[0].data)
        assertEquals(1_000L, all[0].sentAt)
        assertEquals("device_a", all[0].authorDeviceId)
        assertNull(all[0].localMetadata)
    }

    @Test
    fun `put is blind — an older write overwrites a newer one`() = runBlocking {
        store.put("pix", entry("pix_1", data = """{"v":"new"}""", sentAt = 9_000))
        store.put("pix", entry("pix_1", data = """{"v":"old"}""", sentAt = 1_000))

        val all = store.all("pix")

        assertEquals(1, all.size, "same (model, id) is one row")
        assertEquals("""{"v":"old"}""", all[0].data,
            "the store must not re-decide the merge; the app already did")
        assertEquals(1_000L, all[0].sentAt)
    }

    @Test
    fun `models do not bleed into each other`() = runBlocking {
        store.put("directMessage", entry("a"))
        store.put("story", entry("b"))

        assertEquals(listOf("a"), store.all("directMessage").map { it.id })
        assertEquals(listOf("b"), store.all("story").map { it.id })
        assertEquals(emptyList<String>(), store.all("profile").map { it.id })
    }

    @Test
    fun `data is stored verbatim, including content the kit cannot parse`() = runBlocking {
        val notJson = """this is not json at all {{{"""
        store.put("weird", entry("w", data = notJson))

        assertEquals(notJson, store.all("weird").single().data,
            "the kit must not validate a shape it is forbidden to read")
    }

    @Test
    fun `unicode and nested payloads survive unchanged`() = runBlocking {
        val payload = """{"content":"sunset 🌅","meta":{"x":0.5,"tags":["a","b"]}}"""
        store.put("story", entry("s", data = payload))

        assertEquals(payload, store.all("story").single().data)
    }

    @Test
    fun `all on an unknown model is empty rather than an error`() = runBlocking {
        assertEquals(emptyList<StoredEntry>(), store.all("neverSeen"))
    }

    @Test
    fun `merge metadata round-trips exactly`() = runBlocking {
        store.put("pix", entry("p", sentAt = 1_700_000_000_123, device = "device_zzz"))

        val stored = store.all("pix").single()

        assertEquals(1_700_000_000_123L, stored.sentAt)
        assertEquals("device_zzz", stored.authorDeviceId)
    }

    @Test
    fun `local metadata round-trips verbatim and remains nullable`() = runBlocking {
        val metadata = """{"uploadState":"complete","attempts":2}"""
        store.put("pix", entry("with_meta", localMetadata = metadata))
        store.put("pix", entry("without_meta"))

        val stored = store.all("pix").associateBy { it.id }

        assertEquals(metadata, stored.getValue("with_meta").localMetadata)
        assertNull(stored.getValue("without_meta").localMetadata)
    }

    @Test
    fun `put replaces local metadata with the app supplied value`() = runBlocking {
        store.put("pix", entry("pix_1", localMetadata = """{"state":"pending"}"""))
        store.put("pix", entry("pix_1", localMetadata = null))

        assertNull(store.all("pix").single().localMetadata)
    }

    @Test
    fun `get returns only the named entries of that model`() = runBlocking {
        store.put("directMessage", entry("dm_1"))
        store.put("directMessage", entry("dm_2"))
        store.put("directMessage", entry("dm_3"))
        store.put("pix", entry("dm_1"))

        assertEquals(setOf("dm_1", "dm_3"), store.get("directMessage", listOf("dm_1", "dm_3", "missing")).map { it.id }.toSet())
        assertEquals(entry("dm_2"), store.get("directMessage", listOf("dm_2")).single())
        assertEquals(emptyList<StoredEntry>(), store.get("directMessage", emptyList()))
    }

    @Test
    fun `erase removes only the named entries`() = runBlocking {
        store.put("directMessage", entry("dm_1"))
        store.put("directMessage", entry("dm_2"))
        store.put("directMessage", entry("dm_3"))
        store.put("pix", entry("dm_1"))

        store.erase("directMessage", listOf("dm_1", "dm_3"))

        assertEquals(listOf("dm_2"), store.all("directMessage").map { it.id })
        assertEquals(listOf("dm_1"), store.all("pix").map { it.id })
    }

    @Test
    fun `erasing missing entries or none is a no-op`() = runBlocking {
        store.put("directMessage", entry("dm_1"))

        store.erase("directMessage", listOf("never_written"))
        store.erase("directMessage", emptyList())

        assertEquals(1, store.all("directMessage").size)
    }

    @Test
    fun `erased content is not recoverable from the database or its WAL`() = runBlocking {
        val dir = File("build/test-databases/erase-${java.util.UUID.randomUUID()}").also { it.mkdirs() }
        val path = File(dir, "erase.db")
        val driver = JdbcSqliteDriver("jdbc:sqlite:${path.absolutePath}")
        ObscuraDatabase.Schema.create(driver)
        driver.pragma("PRAGMA journal_mode = WAL")
        val fileStore = EntryStore(ObscuraDatabase(driver), driver)
        val secrets = listOf("ERASE-ME-7f3a9c", "ERASE-ME-2b8d41")
        fun onDisk(secret: String): Boolean = listOf(path, File("${path.absolutePath}-wal"))
            .filter { it.exists() }
            .any { String(it.readBytes(), Charsets.ISO_8859_1).contains(secret) }

        secrets.forEachIndexed { i, secret -> fileStore.put("directMessage", entry("dm_$i", data = """{"content":"$secret"}""")) }
        assertTrue(secrets.all(::onDisk), "control: the secrets must be on disk before erase")

        fileStore.erase("directMessage", secrets.indices.map { "dm_$it" })

        assertFalse(secrets.any(::onDisk), "erased content must not survive in the database or its WAL")
        driver.close()
        dir.deleteRecursively()
        Unit
    }

    @Test
    fun `erase chunks more than SQLite parameter limit`() = runBlocking {
        val ids = (1..1200).map { "entry-$it" }
        ids.forEach { store.put("m", entry(it)) }
        store.put("other", entry(ids.first()))
        store.erase("m", ids)
        assertTrue(store.all("m").isEmpty())
        assertEquals(1, store.all("other").size)
    }
}
