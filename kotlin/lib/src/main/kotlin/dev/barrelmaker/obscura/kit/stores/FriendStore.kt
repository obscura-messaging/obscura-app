package dev.barrelmaker.obscura.kit.stores

import app.cash.sqldelight.coroutines.asFlow
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

enum class FriendStatus(val value: String) {
    PENDING_SENT("pending_sent"),
    PENDING_RECEIVED("pending_received"),
    ACCEPTED("accepted"),
}

data class FriendData(val userId: String, val username: String, val status: FriendStatus)

/** The whole friend list at one version. */
internal data class FriendList(val version: Long, val friends: List<FriendData>)

/** Every change increments the list's version in the same transaction; [replaceInTransaction] sets it. */
internal class FriendStore(private val db: ObscuraDatabase) {
    private val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val queries = db.friendQueries

    /** Emits once on collection and after every change to the friend table. */
    val changes: Flow<Unit> = queries.selectAll(::friend).asFlow().map { }

    suspend fun add(userId: String, username: String, status: FriendStatus) = withContext(dispatcher) {
        addInTransaction(userId, username, status)
    }

    suspend fun get(userId: String): FriendData? = withContext(dispatcher) {
        getInTransaction(userId)
    }

    internal fun addInTransaction(userId: String, username: String, status: FriendStatus) = db.transaction {
        queries.insert(userId, username, status.value)
        queries.incrementVersion()
    }

    internal fun getInTransaction(userId: String): FriendData? =
        queries.selectById(userId, ::friend).executeAsOneOrNull()

    /** Changes the status only. A status change driven by a peer must never carry a name with it. */
    internal fun updateStatusInTransaction(userId: String, status: FriendStatus): Boolean =
        changed { queries.updateStatus(status.value, userId) }

    suspend fun getAll(): List<FriendData> = withContext(dispatcher) { queries.selectAll(::friend).executeAsList() }

    suspend fun list(): FriendList = withContext(dispatcher) {
        db.transactionWithResult { FriendList(versionInTransaction(), queries.selectAll(::friend).executeAsList()) }
    }

    internal fun versionInTransaction(): Long = queries.selectVersion().executeAsOneOrNull() ?: 0L

    /** Replace the whole list and its version. Joins an enclosing transaction. */
    internal fun replaceInTransaction(list: FriendList) = db.transaction {
        queries.deleteAll()
        list.friends.forEach { queries.insert(it.userId, it.username, it.status.value) }
        queries.setVersion(list.version)
    }

    /** The existing relationship, or null after recording a new pending-sent one. */
    suspend fun prepareRequest(userId: String, username: String): FriendData? = withContext(dispatcher) {
        db.transactionWithResult {
            queries.selectById(userId, ::friend).executeAsOneOrNull().also {
                if (it == null) addInTransaction(userId, username, FriendStatus.PENDING_SENT)
            }
        }
    }

    suspend fun removePendingRequest(userId: String): Boolean = withContext(dispatcher) {
        changed { queries.deleteIfStatus(userId, FriendStatus.PENDING_SENT.value) }
    }

    suspend fun updateStatus(userId: String, status: FriendStatus): Boolean = withContext(dispatcher) {
        updateStatusInTransaction(userId, status)
    }

    suspend fun remove(userId: String): Boolean = withContext(dispatcher) { changed { queries.deleteById(userId) } }

    private fun changed(write: () -> Unit): Boolean = db.transactionWithResult {
        write()
        (queries.changes().executeAsOne() > 0).also { if (it) queries.incrementVersion() }
    }

    private fun friend(userId: String, username: String, status: String) =
        FriendData(userId, username, FriendStatus.entries.first { it.value == status })
}
