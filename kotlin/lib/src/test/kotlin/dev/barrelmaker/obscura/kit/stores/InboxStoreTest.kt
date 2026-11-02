package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class InboxStoreTest {

    private lateinit var db: ObscuraDatabase
    private lateinit var inbox: InboxStore
    private val discards = mutableListOf<Pair<List<Long>, String>>()

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        db = ObscuraDatabase(driver)
        inbox = InboxStore(db) { ids, reason -> discards.add(ids to reason) }
    }

    private fun record(
        envelopeId: String,
        payload: ByteArray = "{}".toByteArray(),
        modelKey: String = "directMessage",
    ) = InboxInsert(
        envelopeId = envelopeId,
        senderUserId = "user_peer",
        senderDeviceId = "device_peer",
        modelKey = modelKey,
        entryId = "entry_1",
        sentAt = 1_700_000_000_000,
        payload = payload,
    )

    @Test
    fun `a redelivered envelope does not create a second row`() = runBlocking {
        assertTrue(inbox.put(record("env_1")), "first insert should create a row")
        assertFalse(inbox.put(record("env_1")), "redelivery must be absorbed, not duplicated")

        assertEquals(1L, inbox.depth())
    }

    @Test
    fun `redelivery keeps the originally stored row rather than replacing it`() = runBlocking {
        inbox.put(record("env_1", payload = "original".toByteArray()))
        inbox.put(record("env_1", payload = "tampered".toByteArray()))

        val rows = inbox.peek()
        assertEquals(1, rows.size)
        assertEquals("original", String(rows[0].payload),
            "INSERT OR IGNORE keeps the first write; a later copy of the same envelope cannot overwrite it")
    }

    @Test
    fun `put throws rather than reporting stored when the row is not there`() = runBlocking {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        val db = ObscuraDatabase(driver)
        val store = InboxStore(db) { _, _ -> }
        driver.execute(null, "DROP TABLE InboxRow", 0)

        assertThrows(Exception::class.java) {
            runBlocking { store.put(record("env_1")) }
        }
        Unit
    }

    @Test
    fun `peeking twice without consuming returns the same rows`() = runBlocking {
        inbox.put(record("env_1"))
        inbox.put(record("env_2"))

        val first = inbox.peek()
        val second = inbox.peek()

        assertEquals(2, first.size)
        assertEquals(first, second)
        assertEquals(2L, inbox.depth(), "peek must not consume")
    }

    @Test
    fun `peek returns rows in insertion order and respects the limit`() = runBlocking {
        repeat(5) { inbox.put(record("env_$it", payload = "env_$it".toByteArray())) }

        val rows = inbox.peek(limit = 3)

        assertEquals(listOf("env_0", "env_1", "env_2"), rows.map { String(it.payload) })
    }

    @Test
    fun `ids keep increasing after rows are consumed`() = runBlocking {
        inbox.put(record("env_1"))
        inbox.put(record("env_2"))
        val firstBatch = inbox.peek()
        inbox.consume(firstBatch.map { it.id })

        inbox.put(record("env_3"))
        val afterDrain = inbox.peek().single()

        assertTrue(afterDrain.id > firstBatch.maxOf { it.id },
            "rowid reuse would make drain order go backwards; AUTOINCREMENT is what prevents it")
    }

    @Test
    fun `consume is idempotent and accepts a subset`() = runBlocking {
        repeat(3) { inbox.put(record("env_$it", payload = "env_$it".toByteArray())) }
        val rows = inbox.peek()

        inbox.consume(listOf(rows[0].id))
        inbox.consume(listOf(rows[0].id)) // again — partial progress is normal, not an error

        assertEquals(2L, inbox.depth())
        assertEquals(listOf("env_1", "env_2"), inbox.peek().map { String(it.payload) })
    }

    @Test
    fun `consume of an empty list is a no-op`() = runBlocking {
        inbox.put(record("env_1"))

        inbox.consume(emptyList())

        assertEquals(1L, inbox.depth())
    }

    @Test
    fun `discard removes rows and reports them for the security log`() = runBlocking {
        inbox.put(record("env_1"))
        inbox.put(record("env_2"))

        val rows = inbox.peek()
        inbox.discard(listOf(rows[0].id), reason = "unknown modelKey from a newer peer")

        assertEquals(1L, inbox.depth())
        assertEquals(1, discards.size)
        assertEquals("unknown modelKey from a newer peer", discards[0].second)
    }

    @Test
    fun `discarding nothing does not log a security event`() = runBlocking {
        inbox.discard(emptyList(), reason = "nothing to do")

        assertEquals(0, discards.size, "an empty discard is not a data-loss event and must not read as one")
    }

    @Test
    fun `depth reflects what is waiting`() = runBlocking {
        assertEquals(0L, inbox.depth())
        repeat(4) { inbox.put(record("env_$it")) }
        assertEquals(4L, inbox.depth())

        inbox.consume(inbox.peek(limit = 2).map { it.id })

        assertEquals(2L, inbox.depth())
    }

    @Test
    fun `every field survives a round trip, including opaque payload bytes`() = runBlocking {
        val payload = byteArrayOf(0, 1, 2, -1, 127, -128) // deliberately not valid UTF-8
        inbox.put(record("env_1", payload = payload))

        val row = inbox.peek().single()

        assertEquals("user_peer", row.senderUserId)
        assertEquals("device_peer", row.senderDeviceId)
        assertEquals("directMessage", row.modelKey)
        assertEquals("entry_1", row.entryId)
        assertArrayEquals(payload, row.payload, "payload is opaque bytes and must not be re-encoded")
    }
}
