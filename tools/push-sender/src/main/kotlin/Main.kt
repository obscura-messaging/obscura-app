import dev.barrelmaker.obscura.kit.AuthState
import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.ObscuraConfig
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.io.File

private val API = System.getenv("OBSCURA_API_URL") ?: "https://obscura.barrelmaker.dev"
private val PASSWORD = "pushTester!xyz9"
private val STATE_DIR = File(System.getProperty("user.home"), ".cache/obscura-push-tester").apply { mkdirs() }
private val DB_PATH = File(STATE_DIR, "db.sqlite").absolutePath
private val STATE_FILE = File(STATE_DIR, "sender.json")

private fun loadState(): JSONObject =
    if (STATE_FILE.exists()) JSONObject(STATE_FILE.readText()) else JSONObject()

private fun saveState(s: JSONObject) {
    STATE_FILE.writeText(s.toString(2))
}

private fun client(): ObscuraClient =
    ObscuraClient(ObscuraConfig(apiUrl = API, deviceName = "PushTester", databasePath = DB_PATH))

private suspend fun loginOrRegister(c: ObscuraClient): JSONObject {
    val state = loadState()
    val username = state.optString("username", "")
    return if (username.isEmpty()) {
        val newName = "pushtester_${System.currentTimeMillis()}"
        println("Registering new sender: $newName")
        c.register(newName, PASSWORD)
        val out = JSONObject()
            .put("username", newName)
            .put("userId", c.userId)
            .put("deviceId", c.deviceId)
        saveState(out)
        out
    } else {
        println("Logging in as $username")
        c.login(username, PASSWORD)
        require(c.authState.value == AuthState.AUTHENTICATED) { "Login failed: ${c.authState.value}" }
        state
    }
}

private suspend fun connect(c: ObscuraClient) {
    c.connect()
    val deadline = System.currentTimeMillis() + 10_000
    while (c.connectionState.value != ConnectionState.CONNECTED && System.currentTimeMillis() < deadline) {
        delay(200)
    }
    require(c.connectionState.value == ConnectionState.CONNECTED) {
        "Failed to connect, state=${c.connectionState.value}"
    }
}

/** Canonical conversationId — same from both sides. Matches src/domain/conversation.ts. */
private fun conversationId(myUserId: String, friendUserId: String): String =
    listOf(myUserId, friendUserId).sorted().joinToString("_")

/**
 * Send a `directMessage` entry the Obscura app will actually render.
 *
 * Uses the kit's `send(recipientUserIds, …)` — the caller names the recipients and hands over an
 * opaque payload.
 *
 * Fields must match `src/models/schema.ts` → `directMessage`: `conversationId` and `content`.
 * `_authorUserId` is NOT sent — the app's drain stamps it from the envelope, which is the only
 * unforgeable source of who sent this.
 */
private suspend fun sendDirectMessage(c: ObscuraClient, friend: FriendData, text: String) {
    val myUserId = c.userId ?: error("No userId — not authenticated")
    val payload = JSONObject()
        .put("conversationId", conversationId(myUserId, friend.userId))
        .put("content", text)
        .toString()
        .toByteArray()

    c.send(
        recipientUserIds = listOf(friend.userId),
        modelKey = "directMessage",
        entryId = java.util.UUID.randomUUID().toString(),
        sentAt = System.currentTimeMillis(),
        payload = payload,
    )
}

/** Resolve an ACCEPTED friend by username, or exit with a usable message. */
private suspend fun requireFriend(c: ObscuraClient, username: String): FriendData =
    c.getFriends().find { it.username == username && it.status == FriendStatus.ACCEPTED }
        ?: run {
            System.err.println("Not friends with $username (or request not accepted yet).")
            System.err.println("Run `befriend`, then accept it on the phone, then `friends` to confirm.")
            c.disconnect()
            kotlin.system.exitProcess(1)
        }

private fun usage(): Nothing {
    System.err.println(
        """
        push-sender — End-to-end push test sender for Obscura

        Commands:
          init                              Register a new sender account (idempotent; prints userId/username).
          whoami                            Print sender identity.
          befriend <userId> <username>      Send a friend request to the recipient.
          accept-pending                    Accept all pending friend requests (drains for 5s).
          friends                           List friends and their status.
          devices <recipientUsername>       Show which of the recipient's devices a send would target.
          send <recipientUsername> <text>   Send a TEXT message to a friend.
          ping <recipientUsername> [count]  Send "ping N <ts>" N times (default 1) with 500ms gaps.
        """.trimIndent()
    )
    kotlin.system.exitProcess(2)
}

fun main(args: Array<String>) {
    runBlocking { run(args) }
    // OkHttp's shared executor keeps non-daemon threads alive for ~60s after the last call,
    // blocking JVM exit. We're done — force-exit so each invocation returns promptly.
    kotlin.system.exitProcess(0)
}

private suspend fun run(args: Array<String>) {
    if (args.isEmpty()) usage()
    when (args[0]) {
        "init" -> {
            val c = client()
            val s = loginOrRegister(c)
            println("Sender username: ${s.getString("username")}")
            println("Sender userId:   ${s.getString("userId")}")
            c.disconnect()
        }
        "whoami" -> {
            val s = loadState()
            if (s.isEmpty) println("(no state yet — run `init`)")
            else println(s.toString(2))
        }
        "befriend" -> {
            if (args.size < 3) usage()
            val targetUserId = args[1]; val targetUsername = args[2]
            val c = client()
            loginOrRegister(c)
            connect(c)
            c.befriend(targetUserId, targetUsername)
            println("Friend request sent to $targetUsername ($targetUserId). Accept it on the phone.")
            delay(1000)
            c.disconnect()
        }
        "accept-pending" -> {
            val c = client()
            loginOrRegister(c)
            connect(c)
            // Wait for incoming FRIEND_REQUESTs to land in the observed friend graph.
            val deadline = System.currentTimeMillis() + 5_000
            var pending = c.getFriends().filter { it.status == FriendStatus.PENDING_RECEIVED }
            while (pending.isEmpty() && System.currentTimeMillis() < deadline) {
                delay(250)
                pending = c.getFriends().filter { it.status == FriendStatus.PENDING_RECEIVED }
            }
            if (pending.isEmpty()) {
                println("No pending requests.")
            } else {
                for (p in pending) {
                    println("Accepting friend request from ${p.username} (${p.userId})")
                    c.acceptFriend(p.userId)
                    delay(300)
                }
            }
            c.disconnect()
        }
        "friends" -> {
            val c = client()
            loginOrRegister(c)
            connect(c)
            delay(1000)
            val list = c.getFriends()
            if (list.isEmpty()) println("(no friends)")
            list.forEach { println("  ${it.username}  ${it.userId}  ${it.status}") }
            c.disconnect()
        }
        "devices" -> {
            // Diagnostic for "the send succeeded but nothing arrived". `sendToAllDevices` fans out
            // to the device ids cached in the friend record (restored by rebuildDeviceMap on
            // connect) and only re-fetches prekey bundles when that cache is EMPTY — so a stale
            // record silently addresses a device the recipient no longer has.
            if (args.size < 2) usage()
            val recipientUsername = args[1]
            val c = client()
            loginOrRegister(c)
            connect(c)
            delay(800)
            val friend = requireFriend(c, recipientUsername)
            println("friend:  ${friend.username} (${friend.userId})")
            println("cached devices (what a send targets): ${friend.devices.size}")
            friend.devices.forEach { println("  - ${it.id}  ${it.name}") }
            c.disconnect()
        }
        "send" -> {
            if (args.size < 3) usage()
            val recipientUsername = args[1]
            val text = args.drop(2).joinToString(" ")
            val c = client()
            loginOrRegister(c)
            connect(c)
            // Ensure friend list is hydrated (rebuildDeviceMap runs on connect)
            delay(800)
            val friend = requireFriend(c, recipientUsername)
            println("Sending to ${friend.username} (${friend.userId}): \"$text\"")
            sendDirectMessage(c, friend, text)
            delay(1500) // let it flush
            println("Sent.")
            c.disconnect()
        }
        "ping" -> {
            if (args.size < 2) usage()
            val recipientUsername = args[1]
            val count = args.getOrNull(2)?.toIntOrNull() ?: 1
            val c = client()
            loginOrRegister(c)
            connect(c)
            delay(800)
            val friend = requireFriend(c, recipientUsername)
            repeat(count) { i ->
                val text = "ping ${i + 1}/$count @ ${System.currentTimeMillis()}"
                println("→ $text")
                sendDirectMessage(c, friend, text)
                delay(500)
            }
            delay(1500)
            c.disconnect()
        }
        else -> usage()
    }
}
