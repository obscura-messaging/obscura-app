package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.db.SqlDriver
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One stored entry. [data] and [localMetadata] are opaque to the kit; [localMetadata] never leaves the device. */
data class StoredEntry(
    val id: String,
    val data: String,
    val sentAt: Long,
    val authorUserId: String,
    val authorDeviceId: String,
    val localMetadata: String? = null,
)

/** The app's entries, keyed by (model, id). `put` is a blind upsert; the app merges before writing. */
class EntryStore internal constructor(
    private val db: ObscuraDatabase,
    private val driver: SqlDriver,
) {
    private val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val queries = db.modelEntryQueries

    suspend fun put(model: String, entry: StoredEntry) = withContext(dispatcher) {
        queries.insertEntry(model, entry.id, entry.data, entry.sentAt, entry.authorUserId, entry.authorDeviceId, entry.localMetadata)
    }

    /** The stored entries among [ids], in no guaranteed order. */
    suspend fun get(model: String, ids: Collection<String>): List<StoredEntry> = withContext(dispatcher) {
        if (ids.isEmpty()) emptyList() else queries.selectByIds(model, ids, ::entry).executeAsList()
    }

    suspend fun all(model: String): List<StoredEntry> = withContext(dispatcher) {
        queries.selectByModel(model, ::entry).executeAsList()
    }

    /** Every entry of every model, without [StoredEntry.localMetadata]: what a history snapshot carries. */
    internal suspend fun export(): List<Pair<String, StoredEntry>> = withContext(dispatcher) {
        queries.selectAll { model, id, data, sentAt, authorUserId, authorDeviceId, _ ->
            model to StoredEntry(id, data, sentAt, authorUserId, authorDeviceId)
        }.executeAsList()
    }

    internal suspend fun import(entries: List<Pair<String, StoredEntry>>) = withContext(dispatcher) {
        db.transaction {
            entries.forEach { (model, e) ->
                queries.insertEntry(model, e.id, e.data, e.sentAt, e.authorUserId, e.authorDeviceId, e.localMetadata)
            }
        }
    }

    /**
     * Delete entries so their contents cannot be recovered from the database files. `secure_delete`
     * is per connection and drivers may pool, so it is set inside the deleting transaction; the WAL
     * checkpoint then removes the pre-delete pages from the `-wal` file.
     */
    suspend fun erase(model: String, ids: Collection<String>) = withContext(dispatcher) {
        if (ids.isEmpty()) return@withContext
        db.transaction {
            driver.pragma("PRAGMA secure_delete = ON")
            ids.chunked(500).forEach { queries.deleteEntries(model, it) }
        }
        driver.truncateWal()
    }

    @Suppress("UNUSED_PARAMETER")
    private fun entry(
        model: String,
        id: String,
        data: String,
        sentAt: Long,
        authorUserId: String,
        authorDeviceId: String,
        localMetadata: String?,
    ) = StoredEntry(id, data, sentAt, authorUserId, authorDeviceId, localMetadata)
}

/** PRAGMAs go through `executeQuery` because several return a row, which Android's `execute` rejects. */
internal fun SqlDriver.pragma(sql: String) {
    executeQuery(null, sql, { cursor -> cursor.next(); QueryResult.Unit }, 0)
}

internal fun SqlDriver.truncateWal() {
    executeQuery(null, "PRAGMA wal_checkpoint(TRUNCATE)", { cursor ->
        if (!cursor.next().value || cursor.getLong(0) != 0L) {
            throw ObscuraError.StorageFailed("WAL truncation could not complete; checkpoint is busy")
        }
        QueryResult.Unit
    }, 0)
}
