import java.nio.file.Path
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import uniffi.obscura_core.AuthState
import uniffi.obscura_core.ClientEventListener
import uniffi.obscura_core.ConnectionState
import uniffi.obscura_core.EntryModel
import uniffi.obscura_core.FriendStatus
import uniffi.obscura_core.HttpRequest
import uniffi.obscura_core.HttpResponse
import uniffi.obscura_core.LoginScenario
import uniffi.obscura_core.ObscuraClient
import uniffi.obscura_core.ObscuraClientConfig
import uniffi.obscura_core.ObscuraException
import uniffi.obscura_core.ObscuraLogger
import uniffi.obscura_core.PersistedSession
import uniffi.obscura_core.SessionStorage
import uniffi.obscura_core.Transport
import uniffi.obscura_core.WebSocketHandle
import uniffi.obscura_core.WebSocketSink
import uniffi.obscura_core.errorCode
import uniffi.obscura_core.errorMessage
import uniffi.obscura_core.linkCodeDeviceName
import uniffi.obscura_core.validateUsername

private class MemorySessionStorage : SessionStorage {
    @Volatile var session: PersistedSession? = null
    override fun save(session: PersistedSession) {
        this.session = session
    }
    override fun load(): PersistedSession? = session
    override fun clear() {
        session = null
    }
}

private class RecordingLogger : ObscuraLogger {
    val lines = Collections.synchronizedList(mutableListOf<String>())
    override fun log(message: String) { lines += message }
    override fun decryptFailed(sourceUserId: String, reason: String) {}
    override fun ackFailed(envelopeId: String, reason: String) {}
    override fun tokenRefreshFailed(attempt: Int, reason: String) {}
    override fun preKeySyncFailed(reason: String) {}
    override fun identityChanged(userId: String) {}
    override fun sessionEstablishFailed(userId: String, reason: String) {}
    override fun databaseError(store: String, operation: String, reason: String) {}
}

private class RecordingListener : ClientEventListener {
    val authStates = Collections.synchronizedList(mutableListOf<AuthState>())
    val connStates = Collections.synchronizedList(mutableListOf<ConnectionState>())
    val models = Collections.synchronizedList(mutableListOf<EntryModel>())
    override fun onConnectionStateChanged(state: ConnectionState) { connStates += state }
    override fun onAuthStateChanged(state: AuthState) { authStates += state }
    override fun onFriendsChanged() {}
    override fun onFriendRequestReceived() {}
    override fun onMessageReceived(model: EntryModel) { models += model }
    override fun onPeerTypingChanged(peerUserId: String, isTyping: Boolean) {}
}

private class SimpleFakeTransport : Transport {
    private val users = ConcurrentHashMap<String, Pair<String, String>>() // username -> (userId, password)
    private val deviceOwners = ConcurrentHashMap<String, String>() // deviceId -> userId
    private val tokens = ConcurrentHashMap<String, String>() // token -> deviceId

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val path = java.net.URI(request.url).path
        return when {
            request.method == "POST" && path == "/v1/users" -> {
                val body = String(request.body ?: ByteArray(0))
                val username = Regex(""""username"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val password = Regex(""""password"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val userId = UUID.randomUUID().toString()
                val deviceId = UUID.randomUUID().toString()
                val token = "tok_${UUID.randomUUID()}"
                val refresh = "ref_${UUID.randomUUID()}"
                users[username] = userId to password
                deviceOwners[deviceId] = userId
                tokens[token] = deviceId
                val expiresAt = (System.currentTimeMillis() / 1000) + 3600
                val resp = """{"token":"$token","refreshToken":"$refresh","expiresAt":$expiresAt,"userId":"$userId","deviceId":"$deviceId"}"""
                HttpResponse(201u, resp.toByteArray(), null)
            }
            request.method == "POST" && path == "/v1/session" -> {
                val body = String(request.body ?: ByteArray(0))
                val username = Regex(""""username"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val password = Regex(""""password"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val deviceId = Regex(""""deviceId"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val user = users[username] ?: return HttpResponse(401u, "unauthorized".toByteArray(), null)
                if (user.second != password) return HttpResponse(401u, "unauthorized".toByteArray(), null)
                if (deviceOwners[deviceId] != user.first) return HttpResponse(409u, "mismatch".toByteArray(), null)
                val token = "tok_${UUID.randomUUID()}"
                val refresh = "ref_${UUID.randomUUID()}"
                tokens[token] = deviceId
                val expiresAt = (System.currentTimeMillis() / 1000) + 3600
                val resp = """{"token":"$token","refreshToken":"$refresh","expiresAt":$expiresAt,"userId":"${user.first}","deviceId":"$deviceId"}"""
                HttpResponse(200u, resp.toByteArray(), null)
            }
            request.method == "POST" && path == "/v1/link-sessions" -> {
                val body = String(request.body ?: ByteArray(0))
                val username = Regex(""""username"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val password = Regex(""""password"\s*:\s*"([^"]+)"""").find(body)!!.groupValues[1]
                val user = users[username] ?: return HttpResponse(401u, "unauthorized".toByteArray(), null)
                if (user.second != password) return HttpResponse(401u, "unauthorized".toByteArray(), null)
                val expiresAt = (System.currentTimeMillis() / 1000) + 600
                val resp = """{"id":"ls_123","userId":"${user.first}","expiresAt":$expiresAt}"""
                HttpResponse(201u, resp.toByteArray(), null)
            }
            request.method == "POST" && path == "/v1/gateway/ticket" -> {
                HttpResponse(200u, """{"ticket":"tkt_1"}""".toByteArray(), null)
            }
            request.method == "GET" && path == "/v1/keys" -> {
                HttpResponse(200u, """{"oneTimePreKeyCount":100,"kyberPreKeyCount":100}""".toByteArray(), null)
            }
            request.method == "DELETE" && path == "/v1/session" -> {
                HttpResponse(204u, ByteArray(0), null)
            }
            else -> HttpResponse(404u, "not found".toByteArray(), null)
        }
    }

    override fun openWebsocket(url: String, sink: WebSocketSink): WebSocketHandle {
        Thread {
            Thread.sleep(10)
            sink.onOpen()
        }.start()
        return object : WebSocketHandle {
            override fun send(bytes: ByteArray) {}
            override fun closeSocket() {}
        }
    }
}

class BindingsTest {
    @TempDir
    lateinit var dir: Path

    private val keyA = ByteArray(32) { 1 }
    private val keyB = ByteArray(32) { 2 }

    @Test
    fun registerLoginConnectPersistAndDatabaseKeyEnforcement() = runBlocking {
        val transport = SimpleFakeTransport()
        val storage = MemorySessionStorage()
        val logger = RecordingLogger()
        val listener = RecordingListener()
        val dbPath = dir.resolve("alice.db").toString()

        val client = ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = "https://obscura.test",
                databasePath = dbPath,
                databaseKey = keyA,
                deviceName = "Pixel 9",
                attachmentCacheDir = dir.resolve("cache").toString(),
            ),
            storage,
            transport,
            logger,
            listener,
        )

        validateUsername("alice")
        assertThrows<ObscuraException.InvalidArgument> { validateUsername("a") }

        client.register("alice", "pass123")
        assertEquals(AuthState.AUTHENTICATED, client.authState())
        assertEquals("alice", storage.load()?.username)
        assertTrue(client.isPrimary())
        assertTrue(client.friendCode().isNotBlank())

        client.connect()
        assertEquals(ConnectionState.CONNECTED, client.connectionState())

        val linkClient = ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = "https://obscura.test",
                databasePath = null,
                databaseKey = ByteArray(0),
                deviceName = "Alice Tablet",
                attachmentCacheDir = null,
            ),
            MemorySessionStorage(),
            transport,
            RecordingLogger(),
            RecordingListener(),
        )
        assertEquals(LoginScenario.LINK_REQUIRED, linkClient.login("alice", "pass123"))
        val req = linkClient.beginLink("alice", "pass123", "Alice Tablet")
        assertEquals("Alice Tablet", linkCodeDeviceName(req.code()))
        linkClient.shutdown()

        client.logout()
        assertEquals(AuthState.LOGGED_OUT, client.authState())
        assertEquals(LoginScenario.EXISTING_DEVICE, client.login("alice", "pass123"))
        client.shutdown()

        // Opening the same DB with a wrong key throws DatabaseUndecryptable (STORAGE_ERROR)
        val err = assertThrows<ObscuraException.DatabaseUndecryptable> {
            ObscuraClient.open(
                ObscuraClientConfig(
                    apiUrl = "https://obscura.test",
                    databasePath = dbPath,
                    databaseKey = keyB,
                    deviceName = "Pixel 9",
                    attachmentCacheDir = null,
                ),
                storage,
                transport,
                logger,
                listener,
            )
        }
        assertEquals("STORAGE_ERROR", errorCode(err))
        assertTrue(errorMessage(err).isNotBlank())

        // Reopening with the right key and restoring the persisted session succeeds
        val reopened = ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = "https://obscura.test",
                databasePath = dbPath,
                databaseKey = keyA,
                deviceName = "Pixel 9",
                attachmentCacheDir = null,
            ),
            storage,
            transport,
            logger,
            listener,
        )
        assertTrue(reopened.restorePersistedSession())
        assertEquals(AuthState.AUTHENTICATED, reopened.authState())
        assertEquals(ConnectionState.CONNECTED, reopened.connectionState())
        reopened.wipeDevice()
        assertFalse(reopened.isPrimary())
        reopened.shutdown()
    }
}
