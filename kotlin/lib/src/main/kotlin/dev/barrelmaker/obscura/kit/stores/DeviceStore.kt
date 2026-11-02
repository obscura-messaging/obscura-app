package dev.barrelmaker.obscura.kit.stores

import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** This device and the account's primary device. */
internal data class LocalDevice(val deviceId: String, val primaryDeviceId: String) {
    val isPrimary get() = deviceId == primaryDeviceId
}

/** This device, and the device directory: every device the client addresses, its own included. */
internal class DeviceStore(private val db: ObscuraDatabase) {
    private val dispatcher = Dispatchers.IO.limitedParallelism(1)
    private val queries = db.deviceQueries

    suspend fun getIdentity(): String? = getLocal()?.deviceId

    suspend fun getLocal(): LocalDevice? = withContext(dispatcher) { getLocalInTransaction() }

    internal fun getLocalInTransaction(): LocalDevice? =
        queries.selectIdentity().executeAsOneOrNull()?.let { LocalDevice(it.device_id, it.primary_device_id) }

    /** This device and its own directory entry. Joins an enclosing transaction. */
    internal fun storeLocalInTransaction(userId: String, local: LocalDevice) = db.transaction {
        queries.insertIdentity(local.deviceId, local.primaryDeviceId)
        addInTransaction(userId, local.deviceId)
    }

    suspend fun add(userId: String, deviceIds: List<String>) = withContext(dispatcher) {
        db.transaction { deviceIds.forEach { addInTransaction(userId, it) } }
    }

    internal fun addInTransaction(userId: String, deviceId: String) {
        val existing = queries.selectUser(deviceId).executeAsOneOrNull()
        if (existing != null && existing != userId) {
            throw dev.barrelmaker.obscura.kit.ObscuraError.ProtocolViolation("Device $deviceId belongs to $existing, not $userId")
        }
        queries.insert(userId, deviceId)
    }

    suspend fun remove(userId: String, deviceIds: List<String>) = withContext(dispatcher) {
        db.transaction {
            deviceIds.forEach {
                queries.delete(userId, it)
                if (db.friendQueries.changes().executeAsOne() > 0) {
                    db.signalKeyQueries.deleteSession("$it.1")
                }
            }
        }
    }

    suspend fun removeByUser(userId: String) = withContext(dispatcher) {
        db.transaction {
            db.signalKeyQueries.deleteSessionsOfUser(userId)
            queries.deleteByUser(userId)
        }
    }

    suspend fun devicesOf(userId: String): List<String> = withContext(dispatcher) {
        queries.selectByUser(userId).executeAsList()
    }

    suspend fun replace(userId: String, deviceIds: List<String>) = withContext(dispatcher) {
        db.transaction {
            queries.deleteByUser(userId)
            deviceIds.forEach { queries.insert(userId, it) }
        }
    }
}
