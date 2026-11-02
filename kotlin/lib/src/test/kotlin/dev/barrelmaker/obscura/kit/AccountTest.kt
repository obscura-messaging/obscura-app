package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.crypto.LinkCrypto
import dev.barrelmaker.obscura.kit.crypto.fromBase64
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.stores.StoredEntry
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.ecc.Curve
import java.util.Collections
import java.util.UUID

/** Login outcomes, primary provisioning, reset and linking against a stand-in server. */
class AccountTest {
    private val newDeviceId = "019f025a-0000-7de6-84b6-0000000000d9"

    /** The server's account state for one user. */
    private class Account {
        var devices = listOf(SELF_DEVICE_ID to true)
        var loginDeviceId: String? = null
        var linkBody: ByteArray? = null
        var linkStatus = 200
        val attachments = Collections.synchronizedMap(mutableMapOf<String, ByteArray>())
        val requests = Collections.synchronizedList(mutableListOf<RecordedRequest>())
    }

    private val account = Account()
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                account.requests.add(request)
                val path = request.url.encodedPath
                return when {
                    path == "/v1/users" && request.method == "POST" ->
                        MockResponse.Builder().code(201).body(authResponseJson(deviceId = SELF_DEVICE_ID).toString()).build()
                    path == "/v1/session" -> {
                        val reqDeviceId = JSONObject(request.body!!.utf8()).optString("deviceId")
                        if (account.loginDeviceId != null && reqDeviceId == account.loginDeviceId) {
                            json(authResponseJson(deviceId = account.loginDeviceId!!))
                        } else {
                            MockResponse.Builder().code(409).body("""{"error":"Device does not belong to this account"}""").build()
                        }
                    }
                    path == "/v1/users/reset" ->
                        json(authResponseJson(deviceId = newDeviceId))
                    path == "/v1/devices" && request.method == "GET" -> json(JSONObject().put("devices",
                        account.devices.map { (id, primary) -> JSONObject().put("deviceId", id).put("isPrimary", primary) }))
                    path == "/v1/devices" -> json(authResponseJson(deviceId = newDeviceId))
                    path == "/v1/link-sessions" -> json(
                        JSONObject().put("id", "ls-1").put("userId", SELF_USER_ID).put("expiresAt", System.currentTimeMillis() / 1000 + 600)
                    )
                    path == "/v1/link-sessions/ls-1" && request.method == "PUT" && account.linkStatus != 200 ->
                        MockResponse.Builder().code(account.linkStatus).build()
                    path == "/v1/link-sessions/ls-1" && request.method == "PUT" -> {
                        account.linkBody = request.body!!.toByteArray()
                        MockResponse.Builder().build()
                    }
                    path == "/v1/link-sessions/ls-1" -> when {
                        account.linkStatus != 200 -> MockResponse.Builder().code(account.linkStatus).build()
                        account.linkBody == null -> MockResponse.Builder().code(204).build()
                        else -> MockResponse.Builder().body(okio.Buffer().write(account.linkBody!!)).build()
                    }
                    path == "/v1/attachments" -> {
                        val id = UUID.randomUUID().toString()
                        account.attachments[id] = request.body!!.toByteArray()
                        json(JSONObject().put("id", id))
                    }
                    path.startsWith("/v1/attachments/") -> account.attachments[path.removePrefix("/v1/attachments/")]
                        ?.let { MockResponse.Builder().body(okio.Buffer().write(it)).build() } ?: MockResponse.Builder().code(404).build()
                    path == "/v1/gateway/ticket" -> json(JSONObject().put("ticket", "t"))
                    path == "/v1/gateway" -> MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
                    }).build()
                    else -> MockResponse.Builder().code(404).build()
                }
            }
        }
        start()
    }
    private val url = server.url("/").toString().trimEnd('/')

    @AfterEach fun close() = server.close()

    private fun json(body: JSONObject) = MockResponse.Builder().body(body.toString()).build()

    private fun requestsTo(path: String) = account.requests.filter { it.url.encodedPath == path }

    @Test fun `without a stored device login creates a link session and reuses it on beginLink`() = runBlocking {
        val storage = MemoryStorage()
        val c = newClient(url, storage)

        assertEquals(LoginScenario.LINK_REQUIRED, c.login("self", "password"))
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertEquals(1, requestsTo("/v1/link-sessions").size)

        val request = c.beginLink("self", "password", "Tablet")
        assertEquals("ls-1", LinkCrypto.decodeCode(request.code).sessionId)
        assertEquals(1, requestsTo("/v1/link-sessions").size, "beginLink reuses the link session from login")
    }

    @Test fun `a stored device the account no longer has is a device mismatch`() = runBlocking {
        val c = sessionClient(url, MemoryStorage())

        assertEquals(LoginScenario.DEVICE_MISMATCH, c.login("self", "password"))
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)

        account.loginDeviceId = SELF_DEVICE_ID
        assertEquals(LoginScenario.EXISTING_DEVICE, c.login("self", "password"))
        assertEquals(SELF_DEVICE_ID, c.deviceId)
        c.auth.end()
        Unit
    }

    @Test fun `register stores a primary with a new identity once the server accepts it`() = runBlocking {
        val storage = MemoryStorage()
        val c = newClient(url, storage)

        c.register("self", "password")

        val body = JSONObject(requestsTo("/v1/users").single().body!!.utf8())
        assertEquals("self", body.getString("username"))
        assertEquals("password", body.getString("password"))
        assertArrayEquals(c.signalStore.identityKeyPair.publicKey.serialize(), body.getString("identityKey").fromBase64())
        assertEquals(100, body.getJSONArray("oneTimePreKeys").length())
        assertEquals(1, body.getJSONObject("signedPreKey").getInt("keyId"))
        assertTrue(c.isPrimary())
        assertEquals(listOf(SELF_DEVICE_ID), c.devices.devicesOf(SELF_USER_ID))
        assertEquals(SELF_DEVICE_ID, storage.data!!["deviceId"])
        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        c.auth.end()
        Unit
    }

    @Test fun `resetAccount resets the account on the server, wipes old data, and provisions a new primary`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        val oldIdentity = c.signalStore.identityKeyPair.publicKey
        c.entries.put("m", StoredEntry("e", "{}", 1, SELF_USER_ID, SELF_DEVICE_ID))

        c.resetAccount("self", "password")

        val body = JSONObject(requestsTo("/v1/users/reset").single().body!!.utf8())
        assertEquals("self", body.getString("username"))
        assertEquals("password", body.getString("password"))
        assertArrayEquals(c.signalStore.identityKeyPair.publicKey.serialize(), body.getString("identityKey").fromBase64())
        assertFalse(oldIdentity.serialize().contentEquals(c.signalStore.identityKeyPair.publicKey.serialize()))
        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        assertEquals(newDeviceId, c.deviceId)
        assertEquals(newDeviceId, storage.data!!["deviceId"])
        assertTrue(c.isPrimary())
        assertTrue(c.entries.all("m").isEmpty())
        c.auth.end()
        Unit
    }

    @Test fun `a linked device receives the account identity, friends and history and is not primary`() = runBlocking {
        val primary = sessionClient(url, storedSession())
        assertTrue(primary.auth.restore())
        val friends = listOf(FriendData("019f025a-0000-7de6-84b6-000000000002", "alice", FriendStatus.ACCEPTED))
        primary.db.friendQueries.insert(friends[0].userId, friends[0].username, friends[0].status.value)
        primary.db.friendQueries.incrementVersion()
        primary.entries.put("chat", StoredEntry("e1", """{"text":"hi"}""", 42, SELF_USER_ID, SELF_DEVICE_ID, localMetadata = "private"))
        val storage = MemoryStorage()
        val tablet = newClient(url, storage)

        val request = tablet.beginLink("self", "password", "Tablet")
        val code = LinkCrypto.decodeCode(request.code)
        assertEquals("ls-1", code.sessionId)
        assertEquals("Tablet", code.deviceName)
        assertEquals(33, Curve.decodePoint(code.ephemeralPublicKey.toByteArray(), 0).serialize().size)
        primary.approveLink(request.code)
        tablet.completeLink(request)

        assertArrayEquals(primary.signalStore.identityKeyPair.serialize(), tablet.signalStore.identityKeyPair.serialize())
        assertFalse(tablet.isPrimary())
        assertEquals(newDeviceId, tablet.deviceId)
        assertEquals(newDeviceId, storage.data!!["deviceId"])
        assertEquals(friends, tablet.getFriends())
        assertEquals(1L, tablet.db.friendQueries.selectVersion().executeAsOne())
        assertEquals(listOf(StoredEntry("e1", """{"text":"hi"}""", 42, SELF_USER_ID, SELF_DEVICE_ID)), tablet.entries.all("chat"))
        assertEquals(ConnectionState.CONNECTED, tablet.connectionState.value)
        val created = JSONObject(requestsTo("/v1/devices").single { it.method == "POST" }.body!!.utf8())
        assertEquals("ls-1", created.getString("linkSessionId"))
        assertEquals("Tablet", created.getString("name"))
        assertArrayEquals(primary.signalStore.identityKeyPair.publicKey.serialize(), created.getString("identityKey").fromBase64())
        assertTrue(primary.signalStore.identityKeyPair.publicKey.publicKey.verifySignature(
            created.getJSONObject("signedPreKey").getString("publicKey").fromBase64(),
            created.getJSONObject("signedPreKey").getString("signature").fromBase64()))
        assertTrue(account.attachments.values.none { String(it).contains("hi") }, "history is uploaded encrypted")
        tablet.disconnect()
        primary.auth.end()
        tablet.auth.end()
        Unit
    }

    @Test fun `a history that cannot be imported throws but leaves the device linked and authenticated`() = runBlocking {
        val primary = sessionClient(url, storedSession())
        assertTrue(primary.auth.restore())
        primary.entries.put("chat", StoredEntry("e1", "{}", 1, SELF_USER_ID, SELF_DEVICE_ID))
        val storage = MemoryStorage()
        val tablet = newClient(url, storage)
        val request = tablet.beginLink("self", "password", "Tablet")
        primary.approveLink(request.code)
        account.attachments.clear()

        val error = runCatching { tablet.completeLink(request) }.exceptionOrNull()

        assertTrue(error is ObscuraError.Http && error.status == 404, "got $error")
        assertEquals(AuthState.AUTHENTICATED, tablet.authState.value)
        assertEquals(newDeviceId, storage.data!!["deviceId"])
        assertArrayEquals(primary.signalStore.identityKeyPair.serialize(), tablet.signalStore.identityKeyPair.serialize())
        assertTrue(tablet.entries.all("chat").isEmpty())
        primary.auth.end()
        tablet.auth.end()
        Unit
    }

    @Test fun `a bundle that decrypts but names another account is a protocol violation and stores nothing`() = runBlocking {
        val tablet = newClient(url, MemoryStorage())
        val request = tablet.beginLink("self", "password", "Tablet")
        val bundle = obscura.client.v1.Client.LinkBundle.newBuilder()
            .setIdentityKeyPair(com.google.protobuf.ByteString.copyFrom(org.signal.libsignal.protocol.IdentityKeyPair.generate().serialize()))
            .setUserId("019f025a-0000-7de6-84b6-000000000777").setUsername("self").build()
        account.linkBody = LinkCrypto.seal(bundle.toByteArray(), Curve.decodePoint(LinkCrypto.decodeCode(request.code).ephemeralPublicKey.toByteArray(), 0)).toByteArray()

        assertTrue(runCatching { tablet.completeLink(request) }.exceptionOrNull() is ObscuraError.ProtocolViolation)
        assertFalse(tablet.signalStore.hasIdentity())
        assertTrue(requestsTo("/v1/devices").isEmpty())
    }

    @Test fun `an empty entry store links without a history snapshot`() = runBlocking {
        val primary = sessionClient(url, storedSession())
        assertTrue(primary.auth.restore())
        val tablet = newClient(url, MemoryStorage())
        val request = tablet.beginLink("self", "password", "Tablet")

        primary.approveLink(request.code)
        tablet.completeLink(request)

        assertTrue(account.attachments.isEmpty())
        assertTrue(tablet.getFriends().isEmpty())
        tablet.disconnect()
        primary.auth.end()
        tablet.auth.end()
        Unit
    }

    @Test fun `an envelope that does not decrypt fails the link and stores nothing`() = runBlocking {
        val tablet = newClient(url, MemoryStorage())
        val request = tablet.beginLink("self", "password", "Tablet")
        account.linkBody = LinkCrypto.seal(ByteArray(8), Curve.generateKeyPair().publicKey).toByteArray()

        val error = runCatching { tablet.completeLink(request) }.exceptionOrNull()

        assertTrue(error is ObscuraError.LinkFailed, "got $error")
        assertFalse(tablet.signalStore.hasIdentity())
        assertNull(tablet.devices.getIdentity())
        assertTrue(requestsTo("/v1/devices").isEmpty())
    }

    @Test fun `an expired or unknown link session fails the link`() = runBlocking {
        val tablet = newClient(url, MemoryStorage())
        val request = tablet.beginLink("self", "password", "Tablet")
        account.linkStatus = 404

        assertTrue(runCatching { tablet.completeLink(request) }.exceptionOrNull() is ObscuraError.LinkFailed)
        val primary = sessionClient(url, storedSession())
        assertTrue(primary.auth.restore())
        assertTrue(runCatching { primary.approveLink(request.code) }.exceptionOrNull() is ObscuraError.LinkFailed)
        primary.auth.end()
        Unit
    }

    @Test fun `a malformed link code is an invalid argument`() = runBlocking {
        val primary = sessionClient(url, storedSession())
        assertTrue(primary.auth.restore())
        val key = com.google.protobuf.ByteString.copyFrom(Curve.generateKeyPair().publicKey.serialize())
        val valid = LinkCrypto.encodeCode(obscura.client.v1.Client.LinkCode.newBuilder().setSessionId("s").setEphemeralPublicKey(key).build())
        assertEquals("", ObscuraClient.linkCodeDeviceName(valid))
        val notLinkCode = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(byteArrayOf(-1, -1, -1))
        for (code in listOf(
            "", "not base64!", notLinkCode, "$valid=",
            LinkCrypto.encodeCode(obscura.client.v1.Client.LinkCode.newBuilder().setSessionId("s").build()),
            LinkCrypto.encodeCode(obscura.client.v1.Client.LinkCode.newBuilder().setEphemeralPublicKey(key).build()),
        )) {
            assertTrue(runCatching { primary.approveLink(code) }.exceptionOrNull() is ObscuraError.InvalidArgument, code)
            assertTrue(runCatching { ObscuraClient.linkCodeDeviceName(code) }.exceptionOrNull() is ObscuraError.InvalidArgument, code)
        }
        primary.auth.end()
        Unit
    }

    @Test fun `linking requires an unprovisioned device`() = runBlocking {
        val c = sessionClient(url, MemoryStorage())
        assertTrue(runCatching { c.beginLink("self", "password", "Tablet") }.exceptionOrNull() is ObscuraError.InvalidArgument)
        assertTrue(runCatching { newClient(url).beginLink("self", "password", " ") }.exceptionOrNull() is ObscuraError.InvalidArgument)
        assertTrue(account.requests.isEmpty())
    }
}
