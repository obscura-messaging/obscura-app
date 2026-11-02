package dev.barrelmaker.obscura.kit

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.managers.ProvisioningKeys
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils.toApiJson
import org.json.JSONObject
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import dev.barrelmaker.obscura.kit.stores.LocalDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.util.KeyHelper

fun newInMemoryDatabase(): ObscuraDatabase {
    val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
    ObscuraDatabase.Schema.create(driver)
    return ObscuraDatabase(driver)
}

class MemoryStorage(var data: Map<String, String>? = null) : SessionStorage {
    override fun save(data: Map<String, String>) { this.data = data }
    override fun load() = data
    override fun clear() { data = null }
}

fun newClient(apiUrl: String = "https://obscura.invalid", storage: SessionStorage = MemoryStorage()) =
    ObscuraClient(ObscuraConfig(apiUrl, deviceName = "Test"), driver = null, sessionStorage = storage)

const val SELF_USER_ID = "019f025a-0000-7de6-84b6-000000000001"
const val SELF_DEVICE_ID = "019f025a-0000-7de6-84b6-0000000000d1"
const val FAR_FUTURE = 4_102_444_800L

fun authResponseJson(
    token: String = "token",
    refreshToken: String = "rt",
    expiresAt: Long = FAR_FUTURE,
    userId: String = SELF_USER_ID,
    deviceId: String = SELF_DEVICE_ID,
): JSONObject = JSONObject()
    .put("token", token)
    .put("refreshToken", refreshToken)
    .put("expiresAt", expiresAt)
    .put("userId", userId)
    .put("deviceId", deviceId)

fun storedSession(
    token: String = "token",
    refreshToken: String = "rt",
    expiresAt: Long = FAR_FUTURE,
) = MemoryStorage(mapOf(
    "token" to token,
    "refreshToken" to refreshToken,
    "expiresAt" to expiresAt.toString(),
    "userId" to SELF_USER_ID,
    "deviceId" to SELF_DEVICE_ID,
    "username" to "self",
))

/** Authenticated through the stored-session path, with no server to connect to. */
suspend fun authenticatedClient(storage: MemoryStorage = storedSession(), primaryDeviceId: String = SELF_DEVICE_ID): ObscuraClient {
    val client = sessionClient(apiUrl = "http://127.0.0.1:1", storage = storage, primaryDeviceId = primaryDeviceId)
    check(client.restorePersistedSession())
    return client
}

/** A provisioned device ([SELF_DEVICE_ID] of [SELF_USER_ID]), primary unless [primaryDeviceId] says otherwise. */
suspend fun sessionClient(apiUrl: String, storage: SessionStorage, primaryDeviceId: String = SELF_DEVICE_ID): ObscuraClient =
    newClient(apiUrl, storage).also {
        it.signalStore.generateIdentity()
        it.storeLocalDevice(primaryDeviceId)
    }

suspend fun ObscuraClient.storeLocalDevice(primaryDeviceId: String = SELF_DEVICE_ID, deviceId: String = SELF_DEVICE_ID, userId: String = SELF_USER_ID) =
    withContext(Dispatchers.IO) { devices.storeLocalInTransaction(userId, LocalDevice(deviceId, primaryDeviceId)) }

/** A new local identity, as provisioning installs one. */
internal fun SignalStore.generateIdentity(): Pair<IdentityKeyPair, Int> =
    (IdentityKeyPair.generate() to KeyHelper.generateRegistrationId(false)).also { installIdentity(it.first, it.second) }

/** The prekey bundle the server would serve for a device provisioned with these keys. */
internal fun ProvisioningKeys.bundle(deviceId: String): JSONObject = toDeviceKeys().toJson()
    .put("deviceId", deviceId)
    .put("oneTimePreKey", oneTimePreKeys.first().toApiJson().toJson())
