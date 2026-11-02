package dev.barrelmaker.obscura.kit

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client
import obscura.client.v1.Client.ClientMessage
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.first
import dev.barrelmaker.obscura.kit.stores.StoredEntry

/** Session restore, refresh, logout and wipe against a local stand-in server. */
class SessionTest {
    @Volatile private var refreshStatus = 503
    private val refreshCalls = AtomicInteger()
    private val logoutCalls = AtomicInteger()
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/v1/session/refresh") { exchange ->
            refreshCalls.incrementAndGet()
            Thread.sleep(100)
            val body = if (refreshStatus == 200) authResponseJson(refreshToken = "rotated").toString() else "{}"
            exchange.sendResponseHeaders(refreshStatus, body.length.toLong())
            exchange.responseBody.use { it.write(body.toByteArray()) }
        }
        createContext("/v1/session") { exchange ->
            logoutCalls.incrementAndGet()
            exchange.sendResponseHeaders(500, -1)
            exchange.close()
        }
        start()
    }
    private val url = "http://127.0.0.1:${server.address.port}"

    @AfterEach fun stop() = server.stop(0)

    private fun expiredSession() = storedSession(expiresAt = 1)

    @Test
    fun `nothing stored restores nothing`() = runBlocking {
        assertFalse(newClient(url, MemoryStorage()).restorePersistedSession())
    }

    @Test
    fun `an incomplete blob is not restored and is cleared`() = runBlocking {
        val storage = MemoryStorage(mapOf("token" to "t", "userId" to "u"))
        val c = sessionClient(url, storage)

        assertFalse(c.restorePersistedSession())
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
    }

    @Test
    fun `an unavailable server keeps the expired session, authenticated and disconnected`() = runBlocking {
        val storage = expiredSession()
        val c = sessionClient(url, storage)

        assertTrue(c.restorePersistedSession())

        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        assertEquals(ConnectionState.DISCONNECTED, c.connectionState.value)
        assertEquals("rt", storage.data?.get("refreshToken"))
    }

    @Test
    fun `a rejected refresh token signs out and forgets the session`() = runBlocking {
        refreshStatus = 401
        val storage = expiredSession()
        val c = sessionClient(url, storage)

        assertFalse(c.restorePersistedSession())

        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertNull(c.userId)
    }

    @Test
    fun `a refresh persists the rotated refresh token`() = runBlocking {
        refreshStatus = 200
        val storage = expiredSession()
        val c = sessionClient(url, storage)

        assertTrue(c.restorePersistedSession())

        assertEquals("rotated", storage.data?.get("refreshToken"))
        assertEquals(SELF_USER_ID, c.userId)
        assertEquals(SELF_DEVICE_ID, c.deviceId)
        assertEquals("self", c.username)
    }

    @Test
    fun `concurrent refreshes spend the refresh token once`() = runBlocking {
        refreshStatus = 200
        val c = sessionClient(url, expiredSession())
        assertTrue(c.restorePersistedSession())
        refreshCalls.set(0)

        val results = List(8) { async(kotlinx.coroutines.Dispatchers.Default) { c.auth.refresh() } }.awaitAll()

        assertTrue(results.all { it == dev.barrelmaker.obscura.kit.managers.TokenStatus.FRESH })
        assertEquals(1, refreshCalls.get())
    }

    @Test
    fun `logout revokes best effort, clears storage and typing, keeps local data`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.restorePersistedSession())
        c.route(friendRequest(), "019f025a-0000-7de6-84b6-000000000002", "dev", "env-1")
        c.route(typingStarted(), "019f025a-0000-7de6-84b6-000000000002", "dev", "env-2")

        c.logout()

        assertEquals(1, logoutCalls.get())
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertEquals(emptyList<String>(), c.observeTyping("ctx").first())
        assertEquals(1, c.getFriends().size)
        assertThrows(ObscuraError.NotAuthenticated::class.java) { c.friendCode() }
        Unit
    }

    @Test
    fun `wipe deletes every piece of local data`() = runBlocking {
        val c = sessionClient(url, storedSession())
        assertTrue(c.restorePersistedSession())
        c.signalStore.generateIdentity()
        c.storeLocalDevice()
        c.route(friendRequest(), "019f025a-0000-7de6-84b6-000000000002", "dev", "env-1")
        c.route(ClientMessage.getDefaultInstance(), "019f025a-0000-7de6-84b6-000000000002", "dev", "env-2")
        c.entries.put("m", StoredEntry("e", "{}", 1, SELF_USER_ID, "dev"))

        c.wipeDevice()

        assertEquals(emptyList<Any>(), c.getFriends())
        assertEquals(0L, c.inbox.depth())
        assertEquals(emptyList<StoredEntry>(), c.entries.all("m"))
        assertNull(c.devices.getIdentity())
        assertThrows(IllegalStateException::class.java) { c.signalStore.identityKeyPair }
        Unit
    }

    @Test
    fun `signed-out calls fail with NOT_AUTHENTICATED`() = runBlocking {
        val c = newClient(url)
        for (call in listOf<suspend () -> Unit>(
            { c.connect() },
            { c.friendCode() },
            { c.sendTyping(listOf("u"), "ctx", TypingState.STARTED) },
            { c.send(listOf("u"), "m", "e", 1, ByteArray(0)) },
            { c.uploadAttachment(ByteArray(1)) },
        )) {
            val error = runCatching { call() }.exceptionOrNull()
            assertTrue(error is ObscuraError.NotAuthenticated, "got $error")
            assertEquals("NOT_AUTHENTICATED", (error as ObscuraError).code)
        }
    }

    @Test
    fun `typing with a blank context is rejected`() = runBlocking {
        val c = authenticatedClient()
        assertThrows(ObscuraError.InvalidArgument::class.java) {
            runBlocking { c.sendTyping(listOf("u"), " ", TypingState.STARTED) }
        }
        Unit
    }

    @Test
    fun `undeliverable typing is logged, not thrown`() = runBlocking {
        val c = authenticatedClient()
        c.sendTyping(listOf("019f025a-0000-7de6-84b6-000000000002", "019f025a-0000-7de6-84b6-000000000003"), "ctx", TypingState.STARTED)
        assertEquals(2, c.getDebugLog().count { it.contains("TYPING not delivered") })
    }

    @Test
    fun `the debug log keeps the newest 200 lines`() {
        val c = newClient(url)
        repeat(250) { c.disconnect() }
        assertEquals(200, c.getDebugLog().size)
    }

    private fun friendRequest() = ClientMessage.newBuilder()
        .setFriendRequest(obscura.client.v1.friendRequest { username = "alice" }).build()

    private fun typingStarted() = ClientMessage.newBuilder().setTypingSignal(obscura.client.v1.typingSignal {
        contextId = "ctx"
        state = Client.TypingState.TYPING_STATE_STARTED
    }).build()
}
