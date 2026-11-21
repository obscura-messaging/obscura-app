import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest as JdkHttpRequest
import java.net.http.HttpResponse as JdkHttpResponse
import java.net.http.WebSocket as JdkWebSocket
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CompletionStage
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import uniffi.obscura_core.AuthState
import uniffi.obscura_core.ClientEventListener
import uniffi.obscura_core.ConnectionState
import uniffi.obscura_core.ConversationContent
import uniffi.obscura_core.EntryModel
import uniffi.obscura_core.FriendStatus
import uniffi.obscura_core.HttpRequest
import uniffi.obscura_core.HttpResponse
import uniffi.obscura_core.LoginScenario
import uniffi.obscura_core.MediaType
import uniffi.obscura_core.ObscuraClient
import uniffi.obscura_core.ObscuraClientConfig
import uniffi.obscura_core.ObscuraException
import uniffi.obscura_core.ObscuraLogger
import uniffi.obscura_core.PersistedSession
import uniffi.obscura_core.SessionStorage
import uniffi.obscura_core.Transport
import uniffi.obscura_core.WebSocketHandle
import uniffi.obscura_core.WebSocketSink

private class JdkHttpTransport : Transport {
    private val client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(15))
        .build()

    override suspend fun execute(request: HttpRequest): HttpResponse {
        val builder = JdkHttpRequest.newBuilder()
            .uri(URI.create(request.url))
            .timeout(Duration.ofSeconds(15))
        for ((k, v) in request.headers) {
            if (!k.equals("Host", ignoreCase = true) && !k.equals("Content-Length", ignoreCase = true)) {
                builder.header(k, v)
            }
        }
        val bodyPublisher = request.body?.let { JdkHttpRequest.BodyPublishers.ofByteArray(it) }
            ?: JdkHttpRequest.BodyPublishers.noBody()
        builder.method(request.method, bodyPublisher)

        return try {
            val response = client.sendAsync(builder.build(), JdkHttpResponse.BodyHandlers.ofByteArray()).await()
            val retryAfter = response.headers().firstValue("Retry-After").orElse(null)
            HttpResponse(
                status = response.statusCode().toUShort(),
                body = response.body() ?: ByteArray(0),
                retryAfter = retryAfter,
            )
        } catch (e: Exception) {
            throw ObscuraException.ConnectionFailed(e.message ?: e.javaClass.simpleName)
        }
    }

    override fun openWebsocket(url: String, sink: WebSocketSink): WebSocketHandle {
        val binaryBuffer = java.io.ByteArrayOutputStream()
        val wsFuture = client.newWebSocketBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .buildAsync(URI.create(url), object : JdkWebSocket.Listener {
                override fun onOpen(webSocket: JdkWebSocket) {
                    webSocket.request(1)
                    sink.onOpen()
                }

                override fun onBinary(webSocket: JdkWebSocket, data: ByteBuffer, last: Boolean): CompletionStage<*>? {
                    val chunk = ByteArray(data.remaining())
                    data.get(chunk)
                    synchronized(binaryBuffer) {
                        binaryBuffer.write(chunk)
                        if (last) {
                            val full = binaryBuffer.toByteArray()
                            binaryBuffer.reset()
                            sink.onBinary(full)
                        }
                    }
                    webSocket.request(1)
                    return null
                }

                override fun onText(webSocket: JdkWebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
                    if (last) {
                        sink.onText(data.toString())
                    }
                    webSocket.request(1)
                    return null
                }

                override fun onClose(webSocket: JdkWebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
                    sink.onClosed("closed ($statusCode): $reason")
                    return null
                }

                override fun onError(webSocket: JdkWebSocket, error: Throwable) {
                    sink.onClosed(error.message ?: error.javaClass.simpleName)
                }
            })

        return object : WebSocketHandle {
            override fun send(bytes: ByteArray) {
                try {
                    val ws = wsFuture.join()
                    ws.sendBinary(ByteBuffer.wrap(bytes), true).join()
                } catch (e: Exception) {
                    throw ObscuraException.ConnectionFailed(e.message ?: "send failed")
                }
            }

            override fun closeSocket() {
                wsFuture.thenAccept { ws ->
                    try {
                        ws.sendClose(JdkWebSocket.NORMAL_CLOSURE, "")
                    } catch (_: Exception) {}
                }
            }
        }
    }
}

private class LiveMemoryStorage : SessionStorage {
    @Volatile var session: PersistedSession? = null
    override fun save(session: PersistedSession) { this.session = session }
    override fun load(): PersistedSession? = session
    override fun clear() { session = null }
}

private class LiveLogger : ObscuraLogger {
    override fun log(message: String) {}
    override fun decryptFailed(sourceUserId: String, reason: String) {}
    override fun ackFailed(envelopeId: String, reason: String) {}
    override fun tokenRefreshFailed(attempt: Int, reason: String) {}
    override fun preKeySyncFailed(reason: String) {}
    override fun identityChanged(userId: String) {}
    override fun sessionEstablishFailed(userId: String, reason: String) {}
    override fun databaseError(store: String, operation: String, reason: String) {}
}

private class LiveListener : ClientEventListener {
    val friendRequests = AtomicInteger(0)
    val models = Collections.synchronizedList(mutableListOf<EntryModel>())
    override fun onConnectionStateChanged(state: ConnectionState) {}
    override fun onAuthStateChanged(state: AuthState) {}
    override fun onFriendsChanged() {}
    override fun onFriendRequestReceived() { friendRequests.incrementAndGet() }
    override fun onMessageReceived(model: EntryModel) { models += model }
    override fun onPeerTypingChanged(peerUserId: String, isTyping: Boolean) {}
}

@Tag("integration")
class LiveServerIntegrationTest {
    @TempDir
    lateinit var dir: Path

    private val apiUrl = System.getenv("OBSCURA_TEST_API") ?: "http://localhost:3000"

    private suspend fun waitUntil(timeoutMs: Long = 10_000L, predicate: suspend () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            delay(50)
        }
        assertTrue(predicate(), "Timed out waiting for condition after ${timeoutMs}ms")
    }

    @Test
    fun endToEndMessagingAttachmentsAndDeviceLinkingAgainstLiveServer() = runBlocking {
        val transport = JdkHttpTransport()
        val suffix = UUID.randomUUID().toString().replace("-", "").take(10)
        val aliceName = "alice_$suffix"
        val bobName = "bob_$suffix"

        val aliceListener = LiveListener()
        val bobListener = LiveListener()

        val alice = ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = apiUrl,
                databasePath = dir.resolve("alice.db").toString(),
                databaseKey = ByteArray(32) { 0x11 },
                deviceName = "Alice Primary",
                attachmentCacheDir = dir.resolve("alice_cache").toString(),
            ),
            LiveMemoryStorage(),
            transport,
            LiveLogger(),
            aliceListener,
        )
        val bob = ObscuraClient.open(
            ObscuraClientConfig(
                apiUrl = apiUrl,
                databasePath = dir.resolve("bob.db").toString(),
                databaseKey = ByteArray(32) { 0x22 },
                deviceName = "Bob Primary",
                attachmentCacheDir = dir.resolve("bob_cache").toString(),
            ),
            LiveMemoryStorage(),
            transport,
            LiveLogger(),
            bobListener,
        )

        try {
            alice.register(aliceName, "pass_alice_123")
            bob.register(bobName, "pass_bob_123")
            alice.connect()
            bob.connect()

            val aliceId = alice.userId()!!
            val bobId = bob.userId()!!

            // Friend handshake
            alice.addFriendByCode(bob.friendCode())
            waitUntil {
                bobListener.friendRequests.get() == 1 &&
                    bob.getFriends().any { it.userId == aliceId && it.status == FriendStatus.PENDING_RECEIVED }
            }
            bob.acceptFriend(aliceId)
            waitUntil {
                alice.getFriends().any { it.userId == bobId && it.status == FriendStatus.ACCEPTED }
            }

            // 1:1 Direct message & seen receipt
            val msgId = alice.sendMessage(bobId, "Hello live server!")
            waitUntil {
                bob.getMessages().any {
                    it.id == msgId && (it.content as? ConversationContent.Message)?.text == "Hello live server!"
                }
            }
            bob.markSeen(msgId)
            waitUntil {
                alice.getMessages().any { it.id == msgId && it.viewedAt != null }
            }

            // Capture (Pix + Story) upload and download
            val sampleImg = dir.resolve("sample.jpg")
            Files.write(sampleImg, ByteArray(128) { (it % 251).toByte() })
            val captureRes = alice.sendCapture(
                filePath = sampleImg.toString(),
                mediaType = MediaType.PHOTO,
                caption = "live pix",
                captionMeta = null,
                displayDuration = 5,
                peerUserIds = listOf(bobId),
                toStory = true,
            )
            assertTrue(captureRes.undeliveredPeerUserIds.isEmpty())
            assertEquals(false, captureRes.storyUndelivered)

            waitUntil {
                bob.getMessages().any { it.content is ConversationContent.Pix } &&
                    bob.getStories().any { it.authorUserId == aliceId }
            }
            val bobPix = bob.getMessages().first { it.content is ConversationContent.Pix }
            val downloadedPath = bob.downloadAttachmentToCache(bobPix.id)
            assertTrue(Files.exists(Path.of(downloadedPath)))

            // Link a secondary device for Alice and verify history sync
            val aliceTablet = ObscuraClient.open(
                ObscuraClientConfig(
                    apiUrl = apiUrl,
                    databasePath = dir.resolve("alice_tablet.db").toString(),
                    databaseKey = ByteArray(32) { 0x33 },
                    deviceName = "Alice Tablet",
                    attachmentCacheDir = dir.resolve("alice_tablet_cache").toString(),
                ),
                LiveMemoryStorage(),
                transport,
                LiveLogger(),
                LiveListener(),
            )
            try {
                assertEquals(LoginScenario.LINK_REQUIRED, aliceTablet.login(aliceName, "pass_alice_123"))
                val linkReq = aliceTablet.beginLink(aliceName, "pass_alice_123", "Alice Tablet")
                alice.approveLink(linkReq.code())
                aliceTablet.completeLink(linkReq)
                assertEquals(AuthState.AUTHENTICATED, aliceTablet.authState())
                assertTrue(aliceTablet.getMessages().any { it.id == msgId })
            } finally {
                aliceTablet.shutdown()
            }
        } finally {
            alice.shutdown()
            bob.shutdown()
        }
    }
}
