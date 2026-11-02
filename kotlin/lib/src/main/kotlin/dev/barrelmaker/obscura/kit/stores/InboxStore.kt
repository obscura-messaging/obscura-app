package dev.barrelmaker.obscura.kit.stores

import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One inboxed APP_ENTRY row. [payload] is opaque. */
data class InboxRecord(
    val id: Long,
    val senderUserId: String,
    val senderDeviceId: String,
    val modelKey: String,
    val entryId: String,
    val sentAt: Long,
    val payload: ByteArray,
) {
    override fun equals(other: Any?): Boolean = other is InboxRecord &&
        id == other.id && senderUserId == other.senderUserId &&
        senderDeviceId == other.senderDeviceId && modelKey == other.modelKey && entryId == other.entryId &&
        sentAt == other.sentAt && payload.contentEquals(other.payload)

    override fun hashCode(): Int = 31 * id.hashCode() + payload.contentHashCode()
}

internal data class InboxInsert(
    val envelopeId: String,
    val senderUserId: String,
    val senderDeviceId: String,
    val modelKey: String,
    val entryId: String,
    val sentAt: Long,
    val payload: ByteArray,
)

/** Messages persisted before their ack. The receive path writes; the app drains. */
class InboxStore internal constructor(
    private val db: ObscuraDatabase,
    private val onDiscard: (ids: List<Long>, reason: String) -> Unit,
) {
    private val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val queries = db.inboxQueries

    internal suspend fun contains(envelopeId: String): Boolean = withContext(dispatcher) {
        queries.existsByEnvelopeId(envelopeId).executeAsOne()
    }

    /** True when a row was inserted, false when [InboxInsert.envelopeId] was already stored. */
    internal suspend fun put(record: InboxInsert): Boolean = withContext(dispatcher) {
        putInTransaction(record)
    }

    internal fun putInTransaction(record: InboxInsert): Boolean =
        db.transactionWithResult {
            val existed = queries.existsByEnvelopeId(record.envelopeId).executeAsOne()
            queries.insertRow(
                record.envelopeId, record.senderUserId, record.senderDeviceId,
                record.modelKey, record.entryId, record.sentAt, record.payload,
            )
            check(queries.existsByEnvelopeId(record.envelopeId).executeAsOne()) {
                "inbox row for envelope ${record.envelopeId} is absent after insert"
            }
            !existed
        }

    /** The oldest rows, without removing them. Peeking twice returns the same rows. */
    suspend fun peek(limit: Int = 50): List<InboxRecord> = withContext(dispatcher) {
        queries.peek(limit.toLong(), ::InboxRecord).executeAsList()
    }

    /** Remove rows the app has durably processed. Idempotent. */
    suspend fun consume(ids: List<Long>) = withContext(dispatcher) { delete(ids) }

    /** Remove rows the app can never process. This loses data, so it is logged. */
    suspend fun discard(ids: List<Long>, reason: String): List<Long> = withContext(dispatcher) {
        if (ids.isNotEmpty()) {
            delete(ids)
            onDiscard(ids, reason)
        }
        ids
    }

    suspend fun depth(): Long = withContext(dispatcher) { queries.depth().executeAsOne() }

    // SQLite caps bound variables at 999 on older builds.
    private fun delete(ids: List<Long>) = db.transaction { ids.chunked(500).forEach(queries::deleteByIds) }
}
