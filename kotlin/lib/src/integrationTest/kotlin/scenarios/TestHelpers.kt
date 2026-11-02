package scenarios

import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.NoOpLogger
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.ObscuraLogger
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.InboxRecord
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue

val API: String = System.getenv("OBSCURA_TEST_API") ?: "http://localhost:3000"
const val TEST_PASSWORD = "testpass123!xyz"

private val serverUp: Boolean by lazy {
    try {
        java.net.URI("$API/openapi.yaml").toURL().openConnection().apply {
            connectTimeout = 5000
            readTimeout = 5000
        }.getInputStream().close()
        true
    } catch (e: Exception) {
        false
    }
}

fun requireServer() = assumeTrue(serverUp, "no Obscura server at $API")

fun uniqueName(prefix: String): String = "kt_${prefix}_${System.currentTimeMillis()}_${(1000..9999).random()}"

class MemoryStorage(var data: Map<String, String>? = null) : SessionStorage {
    override fun save(data: Map<String, String>) { this.data = data }
    override fun load() = data
    override fun clear() { data = null }
}

fun newClient(
    deviceName: String = "Kotlin Test",
    databasePath: String? = null,
    storage: SessionStorage = MemoryStorage(),
) = ObscuraClient(ObscuraConfig(API, deviceName, databasePath), driver = null, sessionStorage = storage)

suspend fun registerAndConnect(prefix: String, client: ObscuraClient = newClient()): ObscuraClient {
    client.register(uniqueName(prefix), TEST_PASSWORD)
    assertEquals(AuthState.AUTHENTICATED, client.authState.value)
    client.connect()
    return client
}

/**
 * Link a new device to [primary]'s account the way a user does: the new device shows its code, the
 * primary approves the code string, the new device completes and connects.
 */
suspend fun linkDevice(primary: ObscuraClient, deviceName: String, client: ObscuraClient = newClient(deviceName = deviceName)): ObscuraClient =
    coroutineScope {
        val request = client.beginLink(primary.username!!, TEST_PASSWORD, deviceName)
        val completed = async { client.completeLink(request) }
        primary.approveLink(request.code)
        completed.await()
        client
    }

/** Records identity changes; everything else is dropped. */
class IdentityChanges : ObscuraLogger by NoOpLogger {
    val users: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
    override fun identityChanged(userId: String) { users += userId }
}

/** Poll [condition] until it holds or [timeoutMs] passes. */
suspend fun eventually(timeoutMs: Long = 15_000, message: String = "condition", condition: suspend () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
        assertTrue(System.currentTimeMillis() < deadline, "timed out waiting for $message")
        delay(200)
    }
}

suspend fun ObscuraClient.friendStatus(userId: String): FriendStatus? = getFriends().find { it.userId == userId }?.status

suspend fun becomeFriends(a: ObscuraClient, b: ObscuraClient) {
    a.befriend(b.userId!!, b.username!!)
    eventually(message = "friend request") { b.friendStatus(a.userId!!) == FriendStatus.PENDING_RECEIVED }
    b.acceptFriend(a.userId!!)
    eventually(message = "friend accept") { a.friendStatus(b.userId!!) == FriendStatus.ACCEPTED }
    assertEquals(FriendStatus.ACCEPTED, b.friendStatus(a.userId!!))
}

fun InboxRecord.content(): String = runCatching { JSONObject(String(payload)).optString("content") }.getOrDefault("")

/** The inbox row matching [predicate], waiting for it to arrive. */
suspend fun ObscuraClient.awaitRow(timeoutMs: Long = 15_000, predicate: (InboxRecord) -> Boolean): InboxRecord {
    var row: InboxRecord? = null
    eventually(timeoutMs, "inbox row") { inbox.peek(500).find(predicate).also { row = it } != null }
    return row!!
}

suspend fun ObscuraClient.awaitContent(content: String, timeoutMs: Long = 15_000) = awaitRow(timeoutMs) { it.content() == content }

/** Send a direct message entry to [receiver] without waiting for delivery. */
suspend fun sendText(
    sender: ObscuraClient,
    receiver: ObscuraClient,
    text: String,
    modelKey: String = "directMessage",
    sentAt: Long = System.currentTimeMillis(),
) = sender.send(
    recipientUserIds = listOf(receiver.userId!!),
    modelKey = modelKey,
    entryId = "e_${System.currentTimeMillis()}_${(0..99999).random()}",
    sentAt = sentAt,
    payload = JSONObject(mapOf("content" to text)).toString().toByteArray(),
)

suspend fun sendAndVerify(sender: ObscuraClient, receiver: ObscuraClient, text: String): InboxRecord {
    sendText(sender, receiver, text)
    val row = receiver.awaitContent(text)
    assertEquals(sender.userId, row.senderUserId)
    assertEquals(sender.deviceId, row.senderDeviceId)
    return row
}
