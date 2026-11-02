package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.ObscuraError
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class APIClientTest {
    private val server = MockWebServer().apply { start() }
    private val api = APIClient(server.url("/").toString().trimEnd('/')) { "token" }

    @AfterEach fun close() = server.close()

    private fun status(code: Int, retryAfter: String? = null, body: String = "") = MockResponse.Builder().code(code).body(body)
        .apply { if (retryAfter != null) setHeader("Retry-After", retryAfter) }.build()

    @Test
    fun `429 and 503 are retried twice after Retry-After`() = runBlocking {
        server.enqueue(status(429, retryAfter = "0"))
        server.enqueue(status(503))
        server.enqueue(status(200, body = """{"ticket":"t"}"""))

        val started = System.currentTimeMillis()
        assertEquals("t", api.fetchGatewayTicket())

        assertEquals(3, server.requestCount)
        assertTrue(System.currentTimeMillis() - started >= 2_000, "each retry waits at least 1 s")
        assertEquals("Bearer token", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun `a third rate limit is thrown with status and body`() = runBlocking {
        repeat(3) { server.enqueue(status(429, retryAfter = "1", body = "slow down")) }

        val error = runCatching { api.fetchGatewayTicket() }.exceptionOrNull() as ObscuraError.Http

        assertEquals(429, error.status)
        assertEquals("slow down", error.body)
        assertEquals("HTTP_ERROR", error.code)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `other errors are not retried`() = runBlocking {
        server.enqueue(status(500, body = "boom"))
        val error = runCatching { api.fetchGatewayTicket() }.exceptionOrNull() as ObscuraError.Http
        assertEquals(500, error.status)
        assertEquals(1, server.requestCount)
    }

    private fun sessionApi(vararg outcomes: dev.barrelmaker.obscura.kit.managers.TokenStatus): Pair<APIClient, () -> Int> {
        var refreshes = 0
        var token = "old"
        val api = APIClient(server.url("/").toString().trimEnd('/'), refresh = {
            outcomes[refreshes++].also { if (it == dev.barrelmaker.obscura.kit.managers.TokenStatus.FRESH) token = "new" }
        }) { token }
        return api to { refreshes }
    }

    @Test
    fun `a 401 on the session is refreshed and the request retried once with the new token`() = runBlocking {
        val (api, refreshes) = sessionApi(dev.barrelmaker.obscura.kit.managers.TokenStatus.FRESH)
        server.enqueue(status(401))
        server.enqueue(status(200, body = """{"ticket":"t"}"""))

        assertEquals("t", api.fetchGatewayTicket())
        assertEquals(1, refreshes())
        assertEquals("Bearer old", server.takeRequest().headers["Authorization"])
        assertEquals("Bearer new", server.takeRequest().headers["Authorization"])
    }

    @Test
    fun `a second 401 after a refresh is thrown, not refreshed again`() = runBlocking {
        val (api, refreshes) = sessionApi(dev.barrelmaker.obscura.kit.managers.TokenStatus.FRESH)
        server.enqueue(status(401))
        server.enqueue(status(401, body = "still"))

        val error = runCatching { api.fetchAttachment("a") }.exceptionOrNull() as ObscuraError.Http
        assertEquals(401, error.status)
        assertEquals(1, refreshes())
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a rejected refresh after a 401 is NOT_AUTHENTICATED`() = runBlocking {
        val (api, _) = sessionApi(dev.barrelmaker.obscura.kit.managers.TokenStatus.REJECTED)
        server.enqueue(status(401))

        assertTrue(runCatching { api.registerPushToken("p") }.exceptionOrNull() is ObscuraError.NotAuthenticated)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `an unavailable refresh leaves the 401 as an HTTP error`() = runBlocking {
        val (api, _) = sessionApi(dev.barrelmaker.obscura.kit.managers.TokenStatus.UNAVAILABLE)
        server.enqueue(status(401))

        assertEquals(401, (runCatching { api.fetchGatewayTicket() }.exceptionOrNull() as ObscuraError.Http).status)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a 401 on an explicit bearer or unauthenticated call never refreshes`() = runBlocking {
        val (api, refreshes) = sessionApi()
        server.enqueue(status(401))
        server.enqueue(status(401))

        assertEquals(401, (runCatching { api.logout("bearer") }.exceptionOrNull() as ObscuraError.Http).status)
        assertEquals(401, (runCatching { api.login("u", "p", "d") }.exceptionOrNull() as ObscuraError.Http).status)
        assertEquals(0, refreshes())
    }

    @Test
    fun `cancelling a request returns promptly and closes its connection`() = runBlocking {
        java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress()).use { listener ->
            val closed = java.util.concurrent.CountDownLatch(1)
            val requestRead = java.util.concurrent.CountDownLatch(1)
            val serverThread = Thread {
                listener.accept().use { socket ->
                    val input = socket.getInputStream()
                    val head = StringBuilder()
                    while (!head.endsWith("\r\n\r\n")) head.append(input.read().toChar())
                    requestRead.countDown()
                    // Never answer; a read returns -1 once the client closes the connection.
                    if (input.read() == -1) closed.countDown()
                }
            }.apply { start() }
            val slow = APIClient("http://127.0.0.1:${listener.localPort}") { "token" }

            val call = async(kotlinx.coroutines.Dispatchers.Default) { slow.awaitLinkSession("ls") }
            assertTrue(requestRead.await(5, java.util.concurrent.TimeUnit.SECONDS))
            val started = System.currentTimeMillis()
            call.cancel()
            val error = runCatching { call.await() }.exceptionOrNull()

            assertTrue(error is kotlinx.coroutines.CancellationException, "got $error")
            assertTrue(System.currentTimeMillis() - started < 2_000, "cancellation must not wait for the response")
            assertTrue(closed.await(5, java.util.concurrent.TimeUnit.SECONDS), "the server must see the connection closed")
            serverThread.join(5_000)
        }
    }

    @Test
    fun `an authenticated call without a token is NOT_AUTHENTICATED and sends nothing`() = runBlocking {
        val signedOut = APIClient(server.url("/").toString().trimEnd('/')) { null }
        assertTrue(runCatching { signedOut.fetchAttachment("a") }.exceptionOrNull() is ObscuraError.NotAuthenticated)
        assertEquals(0, server.requestCount)
    }
}
