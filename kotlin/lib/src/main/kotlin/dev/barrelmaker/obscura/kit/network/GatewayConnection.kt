package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.ConnectionState
import dev.barrelmaker.obscura.kit.ObscuraError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import xyz.obscura.server.contracts.ObscuraProtocol.AckMessage
import xyz.obscura.server.contracts.ObscuraProtocol.Envelope
import xyz.obscura.server.contracts.ObscuraProtocol.PreKeyStatus
import xyz.obscura.server.contracts.ObscuraProtocol.WebSocketFrame
import java.util.concurrent.TimeUnit

/**
 * The gateway WebSocket and the only owner of reconnection. [connect] returns once the socket is
 * open. A drop or server close after that reconnects with backoff until [disconnect].
 */
internal class GatewayConnection(
    private val api: APIClient,
    private val scope: CoroutineScope,
    /** Runs before every attempt; refreshes the access token. */
    private val beforeConnect: suspend () -> Unit,
    private val log: (String) -> Unit,
) {
    private val http = OkHttpClient.Builder()
        .readTimeout(90, TimeUnit.SECONDS)
        // A missed pong fails the socket, which counts as a drop.
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    val envelopes = Channel<Envelope>(Channel.UNLIMITED)
    val preKeyStatus = Channel<PreKeyStatus>(Channel.CONFLATED)

    private val lock = Any()
    private var socket: WebSocket? = null
    // Bumped by every socket and by disconnect, so callbacks from a superseded socket are ignored.
    private var generation = 0L
    private var pending: CompletableDeferred<Unit>? = null
    private var reconnectJob: Job? = null
    private var reconnectAttempts = 0

    suspend fun connect() {
        var owner = false
        val attempt = synchronized(lock) {
            if (_state.value == ConnectionState.CONNECTED) return
            pending ?: CompletableDeferred<Unit>().also {
                owner = true
                pending = it
                reconnectJob?.cancel()
                reconnectJob = null
                _state.value = ConnectionState.CONNECTING
            }
        }
        if (owner) {
            try {
                open(attempt)
            } catch (e: Exception) {
                synchronized(lock) { if (abandon(attempt)) _state.value = ConnectionState.DISCONNECTED }
                throw connectionError(e)
            }
        }
        attempt.await()
    }

    fun disconnect() {
        val (closing, attempt) = synchronized(lock) {
            generation++
            reconnectJob?.cancel()
            reconnectJob = null
            reconnectAttempts = 0
            _state.value = ConnectionState.DISCONNECTED
            while (envelopes.tryReceive().isSuccess) {}
            while (preKeyStatus.tryReceive().isSuccess) {}
            (socket to pending).also { socket = null; pending = null }
        }
        attempt?.completeExceptionally(ObscuraError.ConnectionFailed("Disconnected"))
        closing?.close(1000, null)
    }

    fun ack(envelopeId: com.google.protobuf.ByteString) {
        val frame = WebSocketFrame.newBuilder().setAck(AckMessage.newBuilder().addMessageIds(envelopeId)).build()
        val ws = synchronized(lock) { socket } ?: throw ObscuraError.ConnectionFailed("Not connected")
        if (!ws.send(frame.toByteArray().toByteString())) throw ObscuraError.ConnectionFailed("Socket is closing")
    }

    private suspend fun open(attempt: CompletableDeferred<Unit>) {
        try {
            beforeConnect()
            val url = api.gatewayUrl(api.fetchGatewayTicket())
            synchronized(lock) {
                if (pending !== attempt) throw ObscuraError.ConnectionFailed("Disconnected")
                socket = http.newWebSocket(Request.Builder().url(url).build(), Listener(++generation, attempt))
            }
            attempt.await()
        } catch (e: Exception) {
            attempt.completeExceptionally(connectionError(e))
            throw e
        }
    }

    private fun connectionError(cause: Exception): Exception = when (cause) {
        is CancellationException, is ObscuraError -> cause
        else -> ObscuraError.ConnectionFailed(cause.message ?: cause.javaClass.simpleName, cause)
    }

    /** Forget a failed attempt and its socket. False when a disconnect or newer attempt already did. */
    private fun abandon(attempt: CompletableDeferred<Unit>): Boolean = synchronized(lock) {
        if (pending !== attempt) return false
        pending = null
        generation++
        socket?.cancel()
        socket = null
        true
    }

    private fun scheduleReconnect(): Unit = synchronized(lock) {
        val delayMs = (1_000L shl reconnectAttempts.coerceAtMost(5)).coerceAtMost(30_000L)
        reconnectAttempts++
        _state.value = ConnectionState.RECONNECTING
        reconnectJob = scope.launch {
            delay(delayMs)
            val attempt = synchronized(lock) {
                if (pending != null) return@launch
                CompletableDeferred<Unit>().also { pending = it }
            }
            try {
                open(attempt)
            } catch (e: CancellationException) {
                abandon(attempt)
                throw e
            } catch (e: Exception) {
                log("GATEWAY reconnect failed: ${e.message}")
                if (abandon(attempt)) scheduleReconnect()
            }
        }
    }

    private inner class Listener(
        private val generation: Long,
        private val attempt: CompletableDeferred<Unit>,
    ) : WebSocketListener() {
        private fun isCurrent() = generation == this@GatewayConnection.generation

        override fun onOpen(webSocket: WebSocket, response: Response) {
            val current = synchronized(lock) {
                isCurrent().also {
                    if (it) {
                        pending = null
                        reconnectAttempts = 0
                        _state.value = ConnectionState.CONNECTED
                    }
                }
            }
            if (current) attempt.complete(Unit) else webSocket.close(1000, null)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (!synchronized(lock) { isCurrent() }) return
            val frame = try {
                WebSocketFrame.parseFrom(bytes.toByteArray())
            } catch (e: Exception) {
                log("GATEWAY undecodable frame (${bytes.size} bytes): ${e.message}")
                ended(ObscuraError.ProtocolViolation("Undecodable gateway frame", e))
                webSocket.cancel()
                return
            }
            if (!frame.hasEnvelopeBatch() && !frame.hasPreKeyStatus()) {
                log("GATEWAY invalid server frame: ${frame.payloadCase}")
                ended(ObscuraError.ProtocolViolation("Unexpected gateway frame: ${frame.payloadCase}"))
                webSocket.cancel()
                return
            }
            synchronized(lock) {
                if (!isCurrent()) return
                when {
                    frame.hasEnvelopeBatch() -> frame.envelopeBatch.envelopesList.forEach { envelopes.trySend(it) }
                    frame.hasPreKeyStatus() -> preKeyStatus.trySend(frame.preKeyStatus)
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!synchronized(lock) { isCurrent() }) return
            log("GATEWAY invalid text frame (${text.length} characters)")
            ended(ObscuraError.ProtocolViolation("Gateway sent a text frame"))
            webSocket.cancel()
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
            ended(IllegalStateException("gateway closed: $code $reason"))

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended(t)

        private fun ended(cause: Throwable) {
            val wasOpen = synchronized(lock) {
                if (!isCurrent()) return
                this@GatewayConnection.generation++
                socket = null
                _state.value == ConnectionState.CONNECTED
            }
            if (wasOpen) {
                log("GATEWAY dropped: ${cause.message}")
                scheduleReconnect()
            } else {
                attempt.completeExceptionally(
                    if (cause is ObscuraError) cause else ObscuraError.ConnectionFailed(cause.message ?: "Gateway closed", cause)
                )
            }
        }
    }
}
