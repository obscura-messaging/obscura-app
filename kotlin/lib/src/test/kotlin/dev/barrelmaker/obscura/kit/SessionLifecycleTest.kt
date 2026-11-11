package dev.barrelmaker.obscura.kit

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.wire.UuidCodec
import dev.barrelmaker.obscura.kit.crypto.PreKeys
import dev.barrelmaker.obscura.kit.auth.TokenStatus
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundles
import dev.barrelmaker.obscura.kit.stores.pragma
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
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
            ConversationItem(
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
            ConversationItem(
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
            val keys = PreKeys.generateProvisioningKeys(IdentityKeyPair.generate(), now.get())
            PreKeys.install(c.signalStore, keys)
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
            // The prekey message makes the client check its pre-key supply.
            server.enqueue(counts(oneTime = 99, kyber = 99))

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

    private fun socketSending(vararg frames: okio.ByteString) = MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
            frames.forEach { webSocket.send(it) }
        }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    }).build()

    private fun counts(oneTime: Int, kyber: Int) =
        MockResponse.Builder().body("""{"oneTimePreKeyCount":$oneTime,"kyberPreKeyCount":$kyber}""").build()

    /** A client provisioned at [provisionedAt] whose clock reads [now]. */
    private suspend fun provisionedClient(provisionedAt: Long, now: Long): Pair<ObscuraClient, dev.barrelmaker.obscura.kit.crypto.ProvisioningKeys> {
        val c = sessionClient(url, storedSession(), clock = { now })
        val keys = PreKeys.generateProvisioningKeys(IdentityKeyPair.generate(), provisionedAt)
        PreKeys.install(c.signalStore, keys)
        c.storeLocalDevice()
        assertTrue(c.auth.restore())
        return c to keys
    }

    @Test fun `a pre-key message makes the client check its supply and refill the kind that is low`() = runBlocking {
        FakeObscuraServer().use { peers ->
            val (c, keys) = provisionedClient(provisionedAt = 1_000_000L, now = 1_000_000L)
            val peer = peers.register("019f025a-0000-7de6-84b6-000000000002")
            peer.directory.add(SELF_USER_ID, listOf(SELF_DEVICE_ID))
            peer.messenger.establishSession(parsePeerBundles(JSONArray().put(keys.bundle(SELF_DEVICE_ID))).single())
            val sub = peer.messenger.prepareSubmission(SELF_DEVICE_ID, ClientMessage.newBuilder().setTimestamp(1).setDirectMessage(
                DirectMessage.newBuilder().setId("dm").setPeerUserId(SELF_USER_ID).setContent("hi"),
            ).build())
            val env = Envelope.newBuilder()
                .setId(UuidCodec.uuidToBytes(UUID.randomUUID()))
                .setSenderUserId(UuidCodec.uuidToBytes(UUID.fromString(peer.userId)))
                .setSenderDeviceId(UuidCodec.uuidToBytes(UUID.fromString(peer.deviceId)))
                .setMessage(sub.message)
                .build()
            val batch = WebSocketFrame.newBuilder().setEnvelopeBatch(EnvelopeBatch.newBuilder().addEnvelopes(env))
                .build().toByteArray().toByteString()

            server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
            server.enqueue(socketSending(batch))
            server.enqueue(counts(oneTime = 9, kyber = 10))
            server.enqueue(MockResponse.Builder().code(200).build())

            c.connect()
            // Calling connect() again while already connected and receiving is a no-op
            c.connect()

            assertEquals("/v1/gateway/ticket", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath)
            assertEquals("/v1/gateway", server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath)
            val check = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("GET /v1/keys", "${check.method} ${check.url.encodedPath}")
            val upload = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("POST /v1/keys", "${upload.method} ${upload.url.encodedPath}")
            val uploaded = JSONObject(upload.body!!.utf8())
            assertEquals(setOf("oneTimePreKeys"), uploaded.keySet(), "only the kind below 10 is refilled")
            assertEquals(PreKeys.BATCH_SIZE, uploaded.getJSONArray("oneTimePreKeys").length())
            assertEquals("hi", c.getMessages().single().content)

            c.disconnect()
            c.auth.end()
            Unit
        }
    }

    /** The sync runs alongside the gateway connect, so requests are answered by route rather than in order. */
    private fun route(vararg responses: Pair<String, () -> MockResponse>) {
        val routes = responses.toMap()
        server.dispatcher = object : mockwebserver3.Dispatcher() {
            override fun dispatch(request: mockwebserver3.RecordedRequest): MockResponse =
                routes["${request.method} ${request.url.encodedPath}"]?.invoke() ?: MockResponse.Builder().code(404).build()
        }
    }

    @Test fun `a connect 2 days after the last sync rotates the signed and last-resort keys`() = runBlocking {
        val (c, keys) = provisionedClient(provisionedAt = 0L, now = PreKeys.REFRESH_INTERVAL_MS)
        route(
            "POST /v1/gateway/ticket" to { MockResponse.Builder().body("""{"ticket":"t"}""").build() },
            "GET /v1/gateway" to { socketSending() },
            "GET /v1/keys" to { counts(oneTime = 50, kyber = 50) },
            "POST /v1/keys" to { MockResponse.Builder().code(200).build() },
        )

        c.connect()

        val paths = (1..4).map { server.takeRequest(5, TimeUnit.SECONDS)!!.let { r -> r to "${r.method} ${r.url.encodedPath}" } }
        assertEquals(setOf("POST /v1/gateway/ticket", "GET /v1/gateway", "GET /v1/keys", "POST /v1/keys"), paths.map { it.second }.toSet())
        val uploaded = JSONObject(paths.single { it.second == "POST /v1/keys" }.first.body!!.utf8())
        assertEquals(setOf("signedPreKey", "lastResortKyberPreKey"), uploaded.keySet())
        withTimeout(5_000) {
            while (c.signalStore.preKeyState()!!.active_signed_id == keys.signedPreKey.id.toLong()) kotlinx.coroutines.delay(10)
        }
        assertEquals(uploaded.getJSONObject("signedPreKey").getInt("keyId").toLong(), c.signalStore.preKeyState()!!.active_signed_id)
        assertFalse(PreKeys.isSyncDue(c.signalStore, PreKeys.REFRESH_INTERVAL_MS))

        c.disconnect()
        c.auth.end()
        Unit
    }

    @Test fun `a connected client checks its supply periodically and refills keys used up by bundle fetches`() = runBlocking {
        val (c, _) = provisionedClient(provisionedAt = 0L, now = 0L)
        c.preKeyCheckIntervalMs = 100
        route(
            "POST /v1/gateway/ticket" to { MockResponse.Builder().body("""{"ticket":"t"}""").build() },
            "GET /v1/gateway" to { socketSending() },
            "GET /v1/keys" to { counts(oneTime = 0, kyber = 50) },
            "POST /v1/keys" to { MockResponse.Builder().code(200).build() },
        )

        c.connect()

        val paths = (1..4).map { server.takeRequest(5, TimeUnit.SECONDS)!!.let { r -> r to "${r.method} ${r.url.encodedPath}" } }
        assertEquals(setOf("POST /v1/gateway/ticket", "GET /v1/gateway", "GET /v1/keys", "POST /v1/keys"), paths.map { it.second }.toSet())
        assertEquals(setOf("oneTimePreKeys"), JSONObject(paths.single { it.second == "POST /v1/keys" }.first.body!!.utf8()).keySet())

        c.disconnect()
        c.auth.end()
        Unit
    }

    @Test fun `logout cancels a pre-key sync in flight`() = runBlocking {
        val (c, _) = provisionedClient(provisionedAt = 0L, now = PreKeys.REFRESH_INTERVAL_MS)
        route(
            "POST /v1/gateway/ticket" to { MockResponse.Builder().body("""{"ticket":"t"}""").build() },
            "GET /v1/gateway" to { socketSending() },
            "GET /v1/keys" to { counts(oneTime = 50, kyber = 50).newBuilder().headersDelay(5, TimeUnit.SECONDS).build() },
            "DELETE /v1/session" to { MockResponse.Builder().code(204).build() },
        )
        c.connect()
        val paths = (1..3).map { server.takeRequest(5, TimeUnit.SECONDS)!!.url.encodedPath }
        assertTrue("/v1/keys" in paths)

        withTimeout(3_000) { c.logout() }

        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
    }

    @Test fun `in-flight refresh completing after logout or session replacement does not clobber current auth state`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        val initialCreds = c.auth.requireCredentials()

        assertTrue(c.auth.restore())

        val otherCreds = initialCreds.copy(token = "other")
        assertNull(c.auth.end(expected = otherCreds))
        assertNull(c.auth.end(expected = c.auth.requireCredentials(), expectedGeneration = 999L))
        assertEquals(AuthState.AUTHENTICATED, c.authState.value)

        // 1) Fails with 500 while logged out -> returns REJECTED
        server.enqueue(refresh(500))
        val failWhileLoggedOut = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end(expected = c.auth.requireCredentials())
        assertEquals(TokenStatus.REJECTED, failWhileLoggedOut.await())

        // 2) Fails with 500 after replacement session restored -> returns FRESH
        storage.data = storedSession(refreshToken = "rep1").data
        assertTrue(c.auth.restore())
        server.enqueue(refresh(500))
        val failAfterReplace = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end(expected = c.auth.requireCredentials())
        storage.data = storedSession(refreshToken = "rep2").data
        assertTrue(c.auth.restore())
        assertEquals(TokenStatus.FRESH, failAfterReplace.await())

        // 3) Succeeds with 200 while logged out -> returns REJECTED
        server.enqueue(refresh(200))
        val okWhileLoggedOut = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end(expected = c.auth.requireCredentials())
        assertEquals(TokenStatus.REJECTED, okWhileLoggedOut.await())

        // 4) Succeeds with 200 after replacement session restored -> returns FRESH
        storage.data = storedSession(refreshToken = "rep3").data
        assertTrue(c.auth.restore())
        server.enqueue(refresh(200))
        val okAfterReplace = async(Dispatchers.Default) { c.auth.refresh() }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        c.auth.end(expected = c.auth.requireCredentials())
        storage.data = storedSession(refreshToken = "rep4").data
        assertTrue(c.auth.restore())
        assertEquals(TokenStatus.FRESH, okAfterReplace.await())
        c.auth.end()
        Unit
    }

    @Test fun `restore cancels in-flight refresh, handles replacement during rejection callback, and rejects mismatched refresh identity`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())

        // Calling restore() while a refresh is in flight cancels refreshInFlight directly in start()
        server.enqueue(refresh(200))
        val canceledByStart = async(Dispatchers.Default) { runCatching { c.auth.refresh() } }
        assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertTrue(c.auth.restore())
        canceledByStart.await()

        // Refresh 401 where logger callback restores a replacement session before onRejected runs
        c.logger = object : ObscuraLogger by NoOpLogger {
            override fun tokenRefreshFailed(attempt: Int, reason: String) {
                c.auth.end(expected = c.auth.credentials)
                storage.data = storedSession(refreshToken = "rep5").data
                runBlocking { c.auth.restore() }
            }
        }
        server.enqueue(MockResponse.Builder().code(401).body("{}").build())
        assertEquals(TokenStatus.FRESH, c.auth.refresh())
        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        c.logger = NoOpLogger

        // Refresh returning credentials for a different userId or deviceId throws ProtocolViolation
        server.enqueue(MockResponse.Builder().body(authResponseJson(userId = UUID.randomUUID().toString()).toString()).build())
        assertTrue(runCatching { c.auth.refresh() }.exceptionOrNull() is ObscuraError.ProtocolViolation)
        server.enqueue(MockResponse.Builder().body(authResponseJson(deviceId = UUID.randomUUID().toString()).toString()).build())
        assertTrue(runCatching { c.auth.refresh() }.exceptionOrNull() is ObscuraError.ProtocolViolation)
        c.auth.end()
        Unit
    }

    @Test fun `refreshAheadOfExpiry retries after failure, stops on rejection, and logs unexpected exceptions`() = runTest {
        val logs = java.util.Collections.synchronizedList(mutableListOf<String>())
        val logger = object : ObscuraLogger by NoOpLogger {
            override fun log(message: String) { logs += message }
        }
        val db = newInMemoryDatabase()
        val signalStore = dev.barrelmaker.obscura.kit.crypto.SignalStore(db).also { it.generateIdentity() }
        val devices = dev.barrelmaker.obscura.kit.stores.DeviceStore(db).also {
            it.storeLocalInTransaction(SELF_USER_ID, dev.barrelmaker.obscura.kit.stores.LocalDevice(SELF_DEVICE_ID, SELF_DEVICE_ID))
        }
        val storage = storedSession(expiresAt = 200L)
        val api = dev.barrelmaker.obscura.kit.network.APIClient(url) { storage.data?.get("token") }
        val mgrScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(testScheduler),
        )
        lateinit var mgr: dev.barrelmaker.obscura.kit.auth.AuthManager
        mgr = dev.barrelmaker.obscura.kit.auth.AuthManager(
            api = api,
            signalStore = signalStore,
            devices = devices,
            storage = storage,
            deviceName = "Test",
            scope = mgrScope,
            logger = { logger },
            onRejected = { creds, gen -> mgr.end(creds, gen) },
            clock = { 90_000L },
        )

        suspend fun stepVirtualTime(ms: Long) {
            advanceTimeBy(ms)
            runCurrent()
            val req = server.takeRequest(5, TimeUnit.SECONDS)
            assertNotNull(req)
            kotlinx.coroutines.withContext(Dispatchers.IO) { Thread.sleep(50) }
            runCurrent()
        }

        // Restore with fresh token (expiresAt = 200s, now = 90s -> 110s left; 80% is 88_000ms)
        assertTrue(mgr.restore())

        // 1st automatic refresh fails with 500 (UNAVAILABLE -> refreshFailures = 1, next delay uses retryDelayMs(1) = 5_000ms)
        server.enqueue(MockResponse.Builder().code(500).body("{}").build())
        // 2nd automatic refresh succeeds with 200 (FRESH -> refreshFailures = 0, expiresAt = 100s -> 8_000ms delay)
        server.enqueue(MockResponse.Builder().code(200).body(authResponseJson(expiresAt = 100L).toString()).build())
        // 3rd automatic refresh throws ProtocolViolation (mismatched userId) -> stops loop and logs
        server.enqueue(MockResponse.Builder().code(200).body(authResponseJson(userId = UUID.randomUUID().toString()).toString()).build())

        stepVirtualTime(88_001L)
        stepVirtualTime(5_001L)
        stepVirtualTime(8_001L)

        assertTrue(logs.any { it.contains("SESSION automatic refresh stopped") })
        mgr.end()

        // Also test automatic refresh stopping cleanly when refresh returns REJECTED (401)
        storage.data = storedSession(expiresAt = 200L).data
        assertTrue(mgr.restore())
        server.enqueue(MockResponse.Builder().code(401).body("{}").build())
        stepVirtualTime(88_001L)
        assertEquals(AuthState.LOGGED_OUT, mgr.state.value)
    }
}
