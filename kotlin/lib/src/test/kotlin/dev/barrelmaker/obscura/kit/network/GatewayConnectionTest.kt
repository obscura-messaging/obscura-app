package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

class GatewayConnectionTest {
    private val server = MockWebServer().apply { start() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val logs = Collections.synchronizedList(mutableListOf<String>())
    private val beforeConnectCalls = AtomicInteger()
    private val gateway = GatewayConnection(
        APIClient(server.url("/").toString().trimEnd('/')) { "t" },
        scope,
        beforeConnect = { beforeConnectCalls.incrementAndGet() },
        log = { logs += it },
    )

    @AfterEach fun close() {
        scope.cancel()
        server.close()
    }

    private fun enqueueGateway(onOpen: (WebSocket) -> Unit = {}) {
        server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) = onOpen(webSocket)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        }).build())
    }

    @Test
    fun `connect returns once open and concurrent callers share one attempt`() = runBlocking {
        enqueueGateway()

        List(3) { async { gateway.connect() } }.awaitAll()

        assertEquals(ConnectionState.CONNECTED, gateway.state.value)
        assertEquals(2, server.requestCount)
        assertEquals(1, beforeConnectCalls.get())
        gateway.connect()
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a server close is followed by one reconnect, refreshing first`() = runBlocking {
        enqueueGateway { it.close(1000, "going away") }
        enqueueGateway()

        gateway.connect()
        withTimeout(5_000) { gateway.state.first { it == ConnectionState.RECONNECTING } }
        withTimeout(5_000) { gateway.state.first { it == ConnectionState.CONNECTED } }
        delay(1_500)

        assertEquals(4, server.requestCount)
        assertEquals(2, beforeConnectCalls.get())
    }

    @Test
    fun `a failed connect throws and does not reconnect`() = runBlocking {
        server.enqueue(MockResponse.Builder().code(500).build())

        assertTrue(runCatching { gateway.connect() }.isFailure)
        delay(1_500)

        assertEquals(ConnectionState.DISCONNECTED, gateway.state.value)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `explicit connect during backoff connects now and all joiners finish once`() = runBlocking {
        enqueueGateway { it.close(1000, "going away") }
        enqueueGateway()
        gateway.connect()
        withTimeout(5_000) { gateway.state.first { it == ConnectionState.RECONNECTING } }

        withTimeout(900) { List(5) { async { gateway.connect() } }.awaitAll() }
        delay(1_200)

        assertEquals(ConnectionState.CONNECTED, gateway.state.value)
        assertEquals(4, server.requestCount)
        assertEquals(2, beforeConnectCalls.get())
    }

    @Test
    fun `a client disconnect does not reconnect`() = runBlocking {
        enqueueGateway()
        enqueueGateway()

        gateway.connect()
        gateway.disconnect()
        delay(1_500)

        assertEquals(ConnectionState.DISCONNECTED, gateway.state.value)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `an undecodable frame is logged and reconnects rather than being swallowed`() = runBlocking {
        enqueueGateway { it.send(byteArrayOf(-1, -1, -1).toByteString()) }
        enqueueGateway()

        gateway.connect()
        withTimeout(5_000) { while (logs.none { it.contains("undecodable frame") }) delay(10) }

        withTimeout(5_000) {
            while (server.requestCount < 4 || gateway.state.value != ConnectionState.CONNECTED) delay(10)
        }
    }

    @Test
    fun `ack without a socket throws`() {
        val error = runCatching { gateway.ack(com.google.protobuf.ByteString.EMPTY) }.exceptionOrNull()
        assertTrue(error is dev.barrelmaker.obscura.kit.ObscuraError.ConnectionFailed)
    }

    @Test
    fun `empty and textual frames are logged and reconnect rather than silently dropped`() = runBlocking {
        for (textual in listOf(false, true)) {
            val previousRequests = server.requestCount
            enqueueGateway { if (textual) it.send("not protobuf") else it.send(byteArrayOf().toByteString()) }
            enqueueGateway()
            gateway.connect()
            withTimeout(5_000) {
                while (server.requestCount < previousRequests + 4 || gateway.state.value != ConnectionState.CONNECTED) delay(10)
            }
            assertTrue(logs.any { it.contains(if (textual) "invalid text frame" else "invalid server frame") })
            gateway.disconnect()
        }
    }
}
