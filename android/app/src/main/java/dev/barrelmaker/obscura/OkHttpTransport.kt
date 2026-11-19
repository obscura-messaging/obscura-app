package dev.barrelmaker.obscura

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import uniffi.obscura_core.HttpRequest
import uniffi.obscura_core.HttpResponse
import uniffi.obscura_core.ObscuraException
import uniffi.obscura_core.Transport
import uniffi.obscura_core.WebSocketHandle
import uniffi.obscura_core.WebSocketSink

/**
 * OS-native HTTP and WebSocket transport for [uniffi.obscura_core.ObscuraClient] backed by OkHttp.
 */
class OkHttpTransport(baseUrl: String) : Transport {

    private val specs =
        if (baseUrl.startsWith("http://")) listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)
        else listOf(ConnectionSpec.MODERN_TLS)

    private val httpClient = OkHttpClient.Builder()
        .connectionSpecs(specs)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val wsClient = OkHttpClient.Builder()
        .connectionSpecs(specs)
        .readTimeout(90, TimeUnit.SECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val contentType = (request.headers["Content-Type"] ?: request.headers["content-type"])
            ?.toMediaTypeOrNull()
        val requestBody = when {
            request.body != null -> request.body!!.toRequestBody(contentType)
            request.method == "POST" || request.method == "PUT" -> ByteArray(0).toRequestBody(contentType)
            else -> null
        }
        val okRequest = try {
            Request.Builder()
                .url(request.url)
                .method(request.method, requestBody)
                .apply {
                    for ((name, value) in request.headers) {
                        header(name, value)
                    }
                }
                .build()
        } catch (e: Exception) {
            throw ObscuraException.InvalidArgument(e.message ?: "Invalid HTTP request")
        }

        return try {
            suspendCancellableCoroutine { continuation ->
                val call = httpClient.newCall(okRequest)
                continuation.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val result = try {
                            response.use { resp ->
                                HttpResponse(
                                    status = resp.code.toUShort(),
                                    body = resp.body?.bytes() ?: ByteArray(0),
                                    retryAfter = resp.header("Retry-After"),
                                )
                            }
                        } catch (e: IOException) {
                            continuation.resumeWithException(e)
                            return
                        }
                        continuation.resume(result)
                    }
                })
            }
        } catch (e: IOException) {
            throw ObscuraException.ConnectionFailed(e.message ?: e.javaClass.simpleName)
        }
    }

    override fun openWebsocket(url: String, sink: WebSocketSink): WebSocketHandle {
        val okRequest = try {
            Request.Builder().url(url).build()
        } catch (e: Exception) {
            throw ObscuraException.ConnectionFailed(e.message ?: "Invalid WebSocket URL")
        }
        val ws = wsClient.newWebSocket(okRequest, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                sink.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                sink.onBinary(bytes.toByteArray())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                sink.onText(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sink.onClosed("gateway closed: $code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sink.onClosed(t.message ?: t.javaClass.simpleName)
            }
        })
        return object : WebSocketHandle {
            override fun send(bytes: ByteArray) {
                if (!ws.send(bytes.toByteString())) {
                    throw ObscuraException.ConnectionFailed("Socket is closing")
                }
            }

            override fun closeSocket() {
                ws.close(1000, null)
            }
        }
    }
}
