package dev.barrelmaker.obscura.kit

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils
import dev.barrelmaker.obscura.kit.managers.TokenStatus
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import dev.barrelmaker.obscura.kit.stores.pragma
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.IdentityKeyPair
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import xyz.obscura.server.contracts.ObscuraProtocol.EnvelopeBatch
import xyz.obscura.server.contracts.ObscuraProtocol.PreKeyStatus
import xyz.obscura.server.contracts.ObscuraProtocol.WebSocketFrame
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class SessionLifecycleTest {
    private val server = MockWebServer().apply { start() }
    private val url = server.url("/").toString().trimEnd('/')

    @AfterEach fun close() = server.close()

    private class FailingStorage : SessionStorage {
        var data: Map<String, String>? = storedSession().data
        var failure: String? = null
        val cause = IllegalStateException("storage unavailable")
        override fun save(data: Map<String, String>) {
            if (failure == "save") throw cause
            this.data = data
        }
        override fun load(): Map<String, String>? {
            if (failure == "load") throw cause
            return data
        }
        override fun clear() {
            if (failure == "clear") throw cause
            data = null
        }
    }

    private fun refresh(status: Int = 200) = MockResponse.Builder().code(status)
        .body(if (status == 200) authResponseJson(refreshToken = "rotated").toString() else "{}")
        .bodyDelay(300, TimeUnit.MILLISECONDS).build()

    @Test fun `wrong credentials on a local device issue exactly one password request`() = runBlocking {
        val c = sessionClient(url, storedSession())
        server.enqueue(MockResponse.Builder().code(401).body("invalid credentials").build())
        // A second response makes the pre-fix extra password request fail promptly instead of hanging.
        server.enqueue(MockResponse.Builder().code(401).body("invalid credentials").build())

        assertEquals(LoginScenario.INVALID_CREDENTIALS, c.login("self", "wrong password"))
        assertEquals(1, server.requestCount)
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertTrue(server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8().contains(SELF_DEVICE_ID))
    }

    @Test fun `authenticated REST operation joins a refresh already in flight before using its token`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(refresh())
        val pending = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        server.enqueue(MockResponse.Builder().code(204).build())

        c.registerPushToken("push-token")

        assertEquals("rotated", storage.data!!["refreshToken"])
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/v1/push-token", request.url.encodedPath)
        assertEquals("Bearer ${c.auth.requireCredentials().token}", request.headers["Authorization"])
        assertEquals(TokenStatus.FRESH, pending.await())
        assertEquals(2, server.requestCount)
        c.auth.end()
        Unit
    }

    @Test fun `restore rejects missing Signal identity and a mismatched device before authentication`() = runBlocking {
        val missing = newClient(url, storedSession())
        missing.storeLocalDevice()
        assertFalse(missing.restorePersistedSession())
        assertEquals(AuthState.LOGGED_OUT, missing.authState.value)

        val mismatch = sessionClient(url, storedSession())
        mismatch.storeLocalDevice(deviceId = "019f025a-0000-7de6-84b6-000000000099")
        assertFalse(mismatch.restorePersistedSession())
        assertEquals(AuthState.LOGGED_OUT, mismatch.authState.value)
        assertEquals(0, server.requestCount)
    }

    @Test fun `storage load and clear errors propagate from auth but nonthrowing restore logs them`() = runBlocking {
        for (operation in listOf("load", "clear")) {
            val storage = FailingStorage().apply {
                failure = operation
                if (operation == "clear") data = null
            }
            val c = sessionClient(url, storage)
            val error = runCatching { c.auth.restore() }.exceptionOrNull()
            assertTrue(error is ObscuraError.StorageFailed)
            assertSame(storage.cause, error!!.cause)
            assertFalse(c.restorePersistedSession())
            assertTrue(c.getDebugLog().any { it.contains("restore failed") })
            assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        }
    }

    @Test fun `initial save failure never authenticates`() = runBlocking {
        val storage = FailingStorage().apply { failure = "save" }
        val c = sessionClient(url, storage)
        val error = runCatching { c.auth.restore() }.exceptionOrNull()
        assertTrue(error is ObscuraError.StorageFailed)
        assertSame(storage.cause, error!!.cause)
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(c.auth.credentials)
    }

    @Test fun `canceling one refresh waiter keeps the single shared refresh for other callers`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(refresh())
        val canceled = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        canceled.cancel()
        assertEquals(TokenStatus.FRESH, c.auth.refresh())
        assertEquals(1, server.requestCount)
        assertEquals("rotated", storage.data!!["refreshToken"])
        c.auth.end()
        Unit
    }

    @Test fun `refresh save failure is storage error not unavailable and cannot publish unsaved tokens`() = runBlocking {
        val storage = FailingStorage()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        val before = c.auth.credentials
        storage.failure = "save"
        server.enqueue(refresh())

        val error = runCatching { c.auth.refresh() }.exceptionOrNull()

        assertTrue(error is ObscuraError.StorageFailed)
        assertSame(storage.cause, error!!.cause)
        assertEquals(before, c.auth.credentials)
        assertEquals("rt", storage.data!!["refreshToken"])
        storage.failure = null
        c.auth.end()
        Unit
    }

    @Test fun `failed durable logout still stops session and typing but propagates original cause`() = runBlocking {
        val storage = FailingStorage()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        c.route(obscura.client.v1.Client.ClientMessage.newBuilder().setTypingSignal(obscura.client.v1.typingSignal {
            contextId = "ctx"
            state = obscura.client.v1.Client.TypingState.TYPING_STATE_STARTED
        }).build(), SELF_USER_ID, SELF_DEVICE_ID, "env")
        storage.failure = "clear"

        val error = runCatching { c.logout() }.exceptionOrNull()

        assertTrue(error is ObscuraError.StorageFailed)
        assertSame(storage.cause, error!!.cause)
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(c.userId)
        assertEquals(ConnectionState.DISCONNECTED, c.connectionState.value)
        assertEquals(emptyList<String>(), c.observeTyping("ctx").first())
        c.content.putConversation(
            dev.barrelmaker.obscura.kit.stores.ConversationItemData(
                "e", SELF_USER_ID, "message", SELF_USER_ID, 1, null, expiresAt(1, null), "kept",
            ),
        )
        val wipeError = runCatching { c.wipeDevice() }.exceptionOrNull()
        assertTrue(wipeError is ObscuraError.StorageFailed)
        assertSame(storage.cause, wipeError!!.cause)
        assertEquals("kept", c.getMessages().single().content)
    }

    @Test fun `late refresh success cannot resurrect logout or overwrite durable storage`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(refresh())
        val pending = async(Dispatchers.Default) { runCatching { c.auth.refresh() } }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        server.enqueue(MockResponse.Builder().code(204).build())

        c.logout()
        pending.await()

        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertNull(c.auth.credentials)
    }

    @Test fun `old refresh rejection cannot log out a replacement session`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(refresh(401))
        val pending = async(Dispatchers.Default) { runCatching { c.auth.refresh() } }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end()
        Unit
        storage.data = storedSession(refreshToken = "replacement").data
        assertTrue(c.auth.restore())
        pending.await()

        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        assertEquals("replacement", c.auth.credentials!!.refreshToken)
        assertEquals("replacement", storage.data!!["refreshToken"])
        c.auth.end()
        Unit
    }

    @Test fun `replacement session does not join the canceled old refresh`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(refresh())
        val pending = async(Dispatchers.Default) { runCatching { c.auth.refresh() } }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end()
        storage.data = storedSession(refreshToken = "replacement").data
        assertTrue(c.auth.restore())
        server.enqueue(refresh())
        assertEquals(TokenStatus.FRESH, c.auth.refresh())
        pending.await()
        assertEquals(2, server.requestCount)
        assertEquals("rotated", storage.data!!["refreshToken"])
        c.auth.end()
        Unit
    }

    @Test fun `a device wipe erases content from the database and truncates the WAL`() = runBlocking {
        val dir = java.io.File("build/test-databases/wipe-${java.util.UUID.randomUUID()}").also { it.mkdirs() }
        val file = java.io.File(dir, "wipe.db")
        val driver = app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver("jdbc:sqlite:${file.absolutePath}")
        dev.barrelmaker.obscura.kit.db.ObscuraDatabase.Schema.create(driver)
        driver.pragma("PRAGMA journal_mode = WAL")
        val c = ObscuraClient(ObscuraConfig(url, "test"), driver, MemoryStorage())
        val secret = "DEVICE-WIPE-SECRET-83a10"
        c.content.putConversation(
            dev.barrelmaker.obscura.kit.stores.ConversationItemData(
                "e", SELF_USER_ID, "message", SELF_USER_ID, 1, null, expiresAt(1, null), secret,
            ),
        )
        fun onDisk() = listOf(file, java.io.File("${file.absolutePath}-wal")).filter { it.exists() }
            .any { String(it.readBytes(), Charsets.ISO_8859_1).contains(secret) }
        assertTrue(onDisk())
        c.wipeDevice()
        assertFalse(onDisk())
        assertTrue(c.getMessages().isEmpty())
        driver.close()
        dir.deleteRecursively()
        Unit
    }

    @Test fun `processPendingMessages connects, drains and acks envelopes, and reconnects a quiet dead socket`() = runBlocking {
        FakeObscuraServer().use { peers ->
            val now = AtomicLong(1_000_000L)
            val c = sessionClient(url, storedSession(), clock = { now.get() })
            val keys = SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate())
            SignalKeyUtils.install(c.signalStore, keys)
            c.storeLocalDevice()
            assertTrue(c.auth.restore())

            // When disconnected and connect() fails, processPendingMessages returns 0 cleanly
            server.enqueue(MockResponse.Builder().code(500).build())
            assertEquals(0, c.processPendingMessages(1_000))
            assertEquals(ConnectionState.DISCONNECTED, c.connectionState.value)

            // Prepare an encrypted DirectMessage envelope from a peer
            val peer = peers.register("019f025a-0000-7de6-84b6-000000000002")
            peer.directory.add(SELF_USER_ID, listOf(SELF_DEVICE_ID))
            peer.messenger.establishSession(parsePeerBundles(JSONArray().put(keys.bundle(SELF_DEVICE_ID))).single())
            val sub = peer.messenger.prepareSubmission(
                SELF_DEVICE_ID,
                ClientMessage.newBuilder().setTimestamp(now.get()).setDirectMessage(
                    DirectMessage.newBuilder().setId("dm_push").setPeerUserId(SELF_USER_ID).setContent("from push"),
                ).build(),
            )
            val envId = UuidCodec.uuidToBytes(UUID.randomUUID())
            val env = Envelope.newBuilder()
                .setId(envId)
                .setSenderUserId(UuidCodec.uuidToBytes(UUID.fromString(peer.userId)))
                .setSenderDeviceId(UuidCodec.uuidToBytes(UUID.fromString(peer.deviceId)))
                .setMessage(sub.message)
                .build()
            val batchFrame = WebSocketFrame.newBuilder()
                .setEnvelopeBatch(EnvelopeBatch.newBuilder().addEnvelopes(env))
                .build()
                .toByteArray()
                .toByteString()

            val acked = CompletableDeferred<List<ByteString>>()
            server.enqueue(MockResponse.Builder().body("""{"ticket":"t1"}""").build())
            server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    webSocket.send(batchFrame)
                }
                override fun onMessage(webSocket: WebSocket, bytes: okio.ByteString) {
                    val frame = WebSocketFrame.parseFrom(bytes.toByteArray())
                    if (frame.hasAck()) acked.complete(frame.ack.messageIdsList)
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }
            }).build())

            assertEquals(1, c.processPendingMessages(5_000))
            assertEquals(listOf(envId), withTimeout(5_000) { acked.await() })
            assertEquals("from push", c.getMessages().single().content)
            assertEquals(ConnectionState.CONNECTED, c.connectionState.value)

            // Calling processPendingMessages while recently active does not reconnect
            assertEquals(0, c.processPendingMessages(0))

            // Advance clock past PUSH_RECENT_ACTIVITY_MS (10_000 ms); an empty drain reconnects the dead socket
            now.addAndGet(15_000L)
            val reconnected = CompletableDeferred<Unit>()
            server.enqueue(MockResponse.Builder().body("""{"ticket":"t2"}""").build())
            server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    reconnected.complete(Unit)
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }
            }).build())

            assertEquals(0, c.processPendingMessages(2_000))
            withTimeout(5_000) { reconnected.await() }
            assertTrue(c.getDebugLog().any { it.contains("PUSH nothing drained on a connected socket; reconnecting") })

            // If reconnect fails on a quiet socket, processPendingMessages returns 0 cleanly
            now.addAndGet(15_000L)
            server.enqueue(MockResponse.Builder().code(500).build())
            assertEquals(0, c.processPendingMessages(1_000))

            c.disconnect()
            c.auth.end()
            Unit
        }
    }

    @Test fun `preKeyStatus frame below threshold triggers automatic prekey replenishment upload`() = runBlocking {
        val c = sessionClient(url, storedSession())
        val keys = SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate())
        SignalKeyUtils.install(c.signalStore, keys)
        c.storeLocalDevice()
        assertTrue(c.auth.restore())

        val okStatus = WebSocketFrame.newBuilder()
            .setPreKeyStatus(PreKeyStatus.newBuilder().setOneTimePreKeyCount(25).setMinThreshold(20))
            .build().toByteArray().toByteString()
        val lowStatus = WebSocketFrame.newBuilder()
            .setPreKeyStatus(PreKeyStatus.newBuilder().setOneTimePreKeyCount(5).setMinThreshold(20))
            .build().toByteArray().toByteString()

        server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                webSocket.send(okStatus)
                webSocket.send(lowStatus)
            }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
        }).build())
        server.enqueue(MockResponse.Builder().code(200).build())

        c.connect()
        // Calling connect() again while already connected and receiving is a no-op
        c.connect()

        assertEquals("/v1/gateway/ticket", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath)
        assertEquals("/v1/gateway", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath)
        val upload = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", upload.method)
        assertEquals("/v1/keys", upload.url.encodedPath)
        val uploadedKeys = JSONObject(upload.body!!.utf8())
        assertEquals(50, uploadedKeys.getJSONArray("oneTimePreKeys").length())
        assertEquals(2, uploadedKeys.getJSONObject("signedPreKey").getInt("keyId"))

        c.disconnect()
        c.auth.end()
        Unit
    }
}
