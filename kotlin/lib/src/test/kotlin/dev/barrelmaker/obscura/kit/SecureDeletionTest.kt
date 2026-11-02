package dev.barrelmaker.obscura.kit

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.stores.StoredEntry
import dev.barrelmaker.obscura.kit.stores.pragma
import dev.barrelmaker.obscura.kit.stores.truncateWal
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.sql.DriverManager
import java.util.UUID

class SecureDeletionTest {
    @Test fun `erase reports a busy checkpoint and removes recoverable content after reader release`() = runBlocking {
        verifyBusyCheckpoint(wipe = false)
    }

    @Test fun `wipe reports a busy checkpoint and securely removes entry and Signal identity after reader release`() = runBlocking {
        verifyBusyCheckpoint(wipe = true)
    }

    private suspend fun verifyBusyCheckpoint(wipe: Boolean) {
        val dir = File("build/test-databases/checkpoint-${UUID.randomUUID()}").also { it.mkdirs() }
        val file = File(dir, "kit.db")
        val wal = File("${file.absolutePath}-wal")
        val driver = JdbcSqliteDriver("jdbc:sqlite:${file.absolutePath}", java.util.Properties().apply {
            setProperty("busy_timeout", "0")
        })
        ObscuraDatabase.Schema.create(driver)
        driver.pragma("PRAGMA journal_mode = WAL")
        driver.pragma("PRAGMA busy_timeout = 0")
        val client = ObscuraClient(ObscuraConfig("http://127.0.0.1:1", "test"), driver, MemoryStorage())
        val signalMarker = client.signalStore.generateIdentity().first.serialize()
        val entryMarker = "CHECKPOINT-SECRET-${UUID.randomUUID()}"
        client.entries.put("m", StoredEntry("e", entryMarker, 1, SELF_USER_ID, SELF_DEVICE_ID))
        driver.truncateWal()
        driver.pragma("PRAGMA secure_delete = OFF")
        fun contains(path: File, marker: ByteArray) = path.exists() &&
            String(path.readBytes(), Charsets.ISO_8859_1).contains(String(marker, Charsets.ISO_8859_1))
        fun onDisk(marker: ByteArray) = listOf(file, wal).any { contains(it, marker) }
        val reader = DriverManager.getConnection("jdbc:sqlite:${file.absolutePath}")
        try {
            reader.autoCommit = false
            reader.createStatement().use { statement ->
                statement.executeQuery("SELECT data FROM ModelEntry").use { rows ->
                    assertTrue(rows.next())
                    client.entries.put("m", StoredEntry("e", "$entryMarker-updated", 2, SELF_USER_ID, SELF_DEVICE_ID))
                    assertTrue(contains(file, signalMarker), "control: Signal identity is present in main database")
                    assertTrue(contains(file, entryMarker.toByteArray()), "control: entry is present in main database")
                    assertTrue(contains(wal, entryMarker.toByteArray()), "control: entry is present in WAL")
                    val error = runCatching {
                        if (wipe) client.wipeDevice() else client.entries.erase("m", listOf("e"))
                    }.exceptionOrNull()
                    assertTrue(error is ObscuraError.StorageFailed, "busy checkpoint must not report success: $error")
                    assertTrue(error!!.message!!.contains("busy"))
                    assertTrue(client.entries.all("m").isEmpty(), "durable delete already committed")
                    assertTrue(onDisk(entryMarker.toByteArray()), "reader prevents secure checkpoint completion")
                }
            }
            reader.rollback()
        } finally {
            reader.close()
        }
        if (wipe) client.wipeDevice() else client.entries.erase("m", listOf("e"))
        assertFalse(onDisk(entryMarker.toByteArray()))
        if (wipe) {
            assertFalse(onDisk(signalMarker))
            assertFalse(client.signalStore.hasIdentity())
        }
        assertTrue(!wal.exists() || wal.length() == 0L)
        driver.close()
        dir.deleteRecursively()
    }
}
