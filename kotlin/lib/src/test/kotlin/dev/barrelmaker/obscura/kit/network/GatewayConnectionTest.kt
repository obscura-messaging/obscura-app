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
    private val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
    private val scope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
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

    private fun advanceVirtualTime(ms: Long = 1_500L) {
        scheduler.advanceTimeBy(ms)
        scheduler.runCurrent()
    }

    private suspend fun awaitReconnectAndAdvance(ms: Long = 1_001L) {
        withTimeout(5_000) { gateway.state.first { it == ConnectionState.RECONNECTING } }
        advanceVirtualTime(ms)
    }

    private fun enqueueGateway(onOpen: (WebSocket) -> Unit = {}) {
        server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
        server.enqueue(MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) = onOpen(webSocket)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        }).build())
    }

    private suspend fun awaitConnected(minRequests: Int = 0) {
        withTimeout(5_000) {
            while (gateway.state.value != ConnectionState.CONNECTED || server.requestCount < minRequests) {
                scheduler.runCurrent()
                delay(5)
            }
        }
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
        awaitReconnectAndAdvance()
        awaitConnected(minRequests = 4)
        advanceVirtualTime(30_000L)

        assertEquals(4, server.requestCount)
        assertEquals(2, beforeConnectCalls.get())
    }

    @Test
    fun `a failed connect throws and does not reconnect`() = runBlocking {
        server.enqueue(MockResponse.Builder().code(500).build())

        assertTrue(runCatching { gateway.connect() }.isFailure)
        advanceVirtualTime(30_000L)

        assertEquals(ConnectionState.DISCONNECTED, gateway.state.value)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `explicit connect during backoff connects now and all joiners finish once`() = runBlocking {
        enqueueGateway { it.close(1000, "going away") }
        enqueueGateway()
        gateway.connect()
        withTimeout(5_000) { gateway.state.first { it == ConnectionState.RECONNECTING } }

        withTimeout(5_000) { List(5) { async { gateway.connect() } }.awaitAll() }
        advanceVirtualTime(30_000L)

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
        advanceVirtualTime(30_000L)

        assertEquals(ConnectionState.DISCONNECTED, gateway.state.value)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `an undecodable frame is logged and reconnects rather than being swallowed`() = runBlocking {
        enqueueGateway { it.send(byteArrayOf(-1, -1, -1).toByteString()) }
        enqueueGateway()

        gateway.connect()
        withTimeout(5_000) { while (logs.none { it.contains("undecodable frame") }) delay(5) }
        awaitReconnectAndAdvance()
        awaitConnected(minRequests = 4)
    }

    @Test
    fun `ack without a socket throws`() {
        val error = runCatching { gateway.ack(com.google.protobuf.ByteString.EMPTY) }.exceptionOrNull()
        assertTrue(error is dev.barrelmaker.obscura.kit.ObscuraError.ConnectionFailed)
    }

    @Test
    fun `empty, unexpected ack, and textual frames are logged and reconnect rather than silently dropped`() = runBlocking {
        val unexpectedAck = xyz.obscura.server.contracts.ObscuraProtocol.WebSocketFrame.newBuilder()
            .setAck(xyz.obscura.server.contracts.ObscuraProtocol.AckMessage.getDefaultInstance())
            .build()
            .toByteArray()
            .toByteString()
        for (payload in listOf<Any>(byteArrayOf().toByteString(), unexpectedAck, "not protobuf")) {
            val previousRequests = server.requestCount
            enqueueGateway {
                when (payload) {
                    is String -> it.send(payload)
                    is okio.ByteString -> it.send(payload)
                }
            }
            enqueueGateway()
            gateway.connect()
            awaitReconnectAndAdvance()
            awaitConnected(minRequests = previousRequests + 4)
            assertTrue(logs.any { it.contains(if (payload is String) "invalid text frame" else "invalid server frame") })
            gateway.disconnect()
        }
    }

    @Test
    fun `envelope batch and prekey status frames are delivered, ack sends while connected, and disconnect drains channels`() = runBlocking {
        val env = xyz.obscura.server.contracts.ObscuraProtocol.Envelope.newBuilder()
            .setId(com.google.protobuf.ByteString.copyFromUtf8("env-1"))
            .build()
        val batchFrame = xyz.obscura.server.contracts.ObscuraProtocol.WebSocketFrame.newBuilder()
            .setEnvelopeBatch(xyz.obscura.server.contracts.ObscuraProtocol.EnvelopeBatch.newBuilder().addEnvelopes(env))
            .build()
            .toByteArray()
            .toByteString()
        val statusFrame = xyz.obscura.server.contracts.ObscuraProtocol.WebSocketFrame.newBuilder()
            .setPreKeyStatus(xyz.obscura.server.contracts.ObscuraProtocol.PreKeyStatus.newBuilder().setOneTimePreKeyCount(5).setMinThreshold(10))
            .build()
            .toByteArray()
            .toByteString()

        enqueueGateway { ws ->
            ws.send(batchFrame)
            ws.send(statusFrame)
        }
        gateway.connect()
        gateway.ack(com.google.protobuf.ByteString.copyFromUtf8("env-1"))

        withTimeout(5_000) {
            while (gateway.envelopes.isEmpty || gateway.preKeyStatus.isEmpty) delay(10)
        }
        gateway.disconnect()
        assertTrue(gateway.envelopes.isEmpty)
        assertTrue(gateway.preKeyStatus.isEmpty)

        // Failed WebSocket upgrade after ticket fetch fails connect without reconnecting
        server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
        server.enqueue(MockResponse.Builder().code(403).body("forbidden").build())
        assertTrue(runCatching { gateway.connect() }.isFailure)
        assertEquals(ConnectionState.DISCONNECTED, gateway.state.value)
    }

    @Test
    fun `reconnect failure retries and closing socket rejects ack`() = runBlocking {
        enqueueGateway { it.close(1000, "drop") }
        server.enqueue(MockResponse.Builder().code(500).body("ticket error").build())
        enqueueGateway()

        gateway.connect()
        awaitReconnectAndAdvance(1_001L)
        withTimeout(5_000) {
            while (logs.none { it.contains("GATEWAY reconnect failed") }) {
                scheduler.runCurrent()
                delay(5)
            }
        }
        awaitReconnectAndAdvance(2_001L)
        awaitConnected()

        // An oversized (>16 MiB) frame causes OkHttp WebSocket.send() to return false and closes the socket
        val ackErr = runCatching {
            gateway.ack(com.google.protobuf.ByteString.copyFrom(ByteArray(17 * 1024 * 1024)))
        }.exceptionOrNull()
        assertTrue(ackErr is dev.barrelmaker.obscura.kit.ObscuraError.ConnectionFailed)
        gateway.disconnect()
    }

    @Test
    fun `disconnect during connect or reconnect aborts cleanly without wall-clock sleeps`() = runBlocking {
        val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()
        val testScope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.test.StandardTestDispatcher(scheduler))
        var hookMode = "disconnect-on-connect"
        lateinit var customGateway: GatewayConnection
        customGateway = GatewayConnection(
            APIClient(server.url("/").toString().trimEnd('/')) { "t" },
            testScope,
            beforeConnect = {
                when (hookMode) {
                    "disconnect-on-connect" -> {
                        server.enqueue(MockResponse.Builder().body("""{"ticket":"t"}""").build())
                        customGateway.disconnect()
                    }
                    "null-message-error" -> throw RuntimeException()
                    "cancel-on-reconnect" -> {
                        customGateway.disconnect()
                        throw kotlinx.coroutines.CancellationException("cancelled reconnect")
                    }
                    "disconnect-and-fail-reconnect" -> {
                        customGateway.disconnect()
                        throw RuntimeException("abandoned reconnect")
                    }
                }
            },
            log = { logs += it },
        )

        val disconnErr = runCatching { customGateway.connect() }.exceptionOrNull()
        assertTrue(disconnErr is dev.barrelmaker.obscura.kit.ObscuraError.ConnectionFailed)

        hookMode = "null-message-error"
        val nullMsgErr = runCatching { customGateway.connect() }.exceptionOrNull()
        assertTrue(nullMsgErr is dev.barrelmaker.obscura.kit.ObscuraError.ConnectionFailed)
        assertEquals("RuntimeException", nullMsgErr?.message)

        hookMode = "ok"
        enqueueGateway {
            hookMode = "cancel-on-reconnect"
            it.close(1000, "drop")
        }
        customGateway.connect()
        withTimeout(5_000) { customGateway.state.first { it == ConnectionState.RECONNECTING } }
        scheduler.advanceTimeBy(1_001L)
        scheduler.runCurrent()
        assertEquals(ConnectionState.DISCONNECTED, customGateway.state.value)

        hookMode = "ok"
        enqueueGateway {
            hookMode = "disconnect-and-fail-reconnect"
            it.close(1000, "drop")
        }
        customGateway.connect()
        withTimeout(5_000) { customGateway.state.first { it == ConnectionState.RECONNECTING } }
        scheduler.advanceTimeBy(1_001L)
        scheduler.runCurrent()
        assertTrue(logs.any { it.contains("abandoned reconnect") })
        assertEquals(ConnectionState.DISCONNECTED, customGateway.state.value)
        testScope.cancel()
    }
}
