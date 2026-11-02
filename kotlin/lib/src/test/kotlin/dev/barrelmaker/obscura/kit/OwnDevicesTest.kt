package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.managers.FakeObscuraServer
import dev.barrelmaker.obscura.kit.messaging.Messenger
import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The account's own devices: the list, the directory and primary it sets, and unlinking. */
class OwnDevicesTest {
    private val server = MockWebServer().apply { start() }
    private val url = server.url("/").toString().trimEnd('/')
    private val other = "019f025a-0000-7de6-84b6-0000000000d2"

    @AfterEach fun close() = server.close()

    private fun deviceList(primary: String) = MockResponse.Builder().body(
        """{"devices":[{"deviceId":"$SELF_DEVICE_ID","name":"Phone","isPrimary":${primary == SELF_DEVICE_ID}},""" +
            """{"deviceId":"$other","name":null,"isPrimary":${primary == other}}]}"""
    ).build()

    private fun paths() = List(server.requestCount) { server.takeRequest().url.encodedPath }

    @Test fun `connect does not list devices or consume prekeys`() = runBlocking {
        val c = sessionClient(url, storedSession(), primaryDeviceId = other)
        assertTrue(c.auth.restore())
        server.enqueue(MockResponse.Builder().code(500).build())

        assertTrue(runCatching { c.connect() }.isFailure)

        assertEquals(listOf(SELF_DEVICE_ID), c.devices.devicesOf(SELF_USER_ID))
        assertFalse(c.isPrimary())
        assertEquals(0L, c.db.signalKeyQueries.countPreKeys().executeAsOne())
        assertFalse(c.signalStore.containsSession(Messenger.addressFor(other)))
        assertEquals(listOf("/v1/gateway/ticket"), paths())
        c.auth.end()
        Unit
    }

    @Test fun `devices lists the account and marks this device`() = runBlocking {
        val c = sessionClient(url, storedSession())
        assertTrue(c.auth.restore())
        server.enqueue(deviceList(primary = SELF_DEVICE_ID))

        assertEquals(listOf(
            DeviceInfo(SELF_DEVICE_ID, "Phone", isPrimary = true, isThisDevice = true),
            DeviceInfo(other, null, isPrimary = false, isThisDevice = false),
        ), c.devices())
        assertTrue(c.isPrimary())
        c.auth.end()
        Unit
    }

    @Test fun `a device list with two primaries is a protocol violation`() = runBlocking {
        val c = sessionClient(url, storedSession())
        assertTrue(c.auth.restore())
        server.enqueue(MockResponse.Builder().body(
            """{"devices":[{"deviceId":"$SELF_DEVICE_ID","isPrimary":true},{"deviceId":"$other","isPrimary":true}]}"""
        ).build())

        assertTrue(runCatching { c.devices() }.exceptionOrNull() is ObscuraError.ProtocolViolation)
        c.auth.end()
        Unit
    }

    @Test fun `a send makes no device-list request and batches self sync with the recipient in one request`() = runBlocking {
        FakeObscuraServer().use { peers ->
            val peer = peers.register("019f025a-0000-7de6-84b6-000000000002")
            val c = sessionClient(url, storedSession())
            assertTrue(c.auth.restore())
            server.enqueue(MockResponse.Builder().body(org.json.JSONObject().put("bundles", org.json.JSONArray().put(peer.consumeBundle())).toString()).build())
            server.enqueue(MockResponse.Builder().body("").build())

            val report = c.send(listOf(peer.userId), "m", "e", 1, byteArrayOf(1))

            assertEquals(SubmissionStatus.ACCEPTED, report.recipients.single().status)
            assertEquals(emptyList<SubmissionResult>(), report.selfSync)
            val requests = List(server.requestCount) { server.takeRequest() }
            assertEquals(listOf("/v1/keys/${peer.userId}", "/v1/messages"), requests.map { it.url.encodedPath })
            val batched = xyz.obscura.server.contracts.ObscuraProtocol.SendMessageRequest.parseFrom(requests[1].body!!.toByteArray())
            assertEquals(1, batched.recipientsList.sumOf { it.submissionsCount })
            assertEquals(listOf(peer.userId, SELF_USER_ID), batched.recipientsList.map { dev.barrelmaker.obscura.kit.crypto.UuidCodec.uuidString(it.userId) })
            c.auth.end()
            Unit
        }
    }

    @Test fun `a rejected token on connect is checked with a refresh and an unlinked device is logged out`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage)
        assertTrue(c.auth.restore())
        server.enqueue(MockResponse.Builder().code(401).body("device deleted").build())
        server.enqueue(MockResponse.Builder().code(401).body("refresh token revoked").build())

        assertTrue(runCatching { c.connect() }.exceptionOrNull() is ObscuraError.NotAuthenticated)

        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertEquals(listOf("/v1/gateway/ticket", "/v1/session/refresh"), paths())
    }

    @Test fun `the primary cannot unlink itself`() = runBlocking {
        val c = sessionClient(url, storedSession())
        assertTrue(c.auth.restore())

        assertTrue(runCatching { c.unlinkDevice(SELF_DEVICE_ID) }.exceptionOrNull() is ObscuraError.InvalidArgument)
        assertEquals(0, server.requestCount)
        c.auth.end()
        Unit
    }

    @Test fun `the primary unlinks another device and forgets it at once`() = runBlocking {
        val c = sessionClient(url, storedSession())
        assertTrue(c.auth.restore())
        c.devices.add(SELF_USER_ID, listOf(other))
        server.enqueue(MockResponse.Builder().build())

        c.unlinkDevice(other)

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/v1/devices/$other", request.url.encodedPath)
        assertEquals(listOf(SELF_DEVICE_ID), c.devices.devicesOf(SELF_USER_ID))
        assertEquals(AuthState.AUTHENTICATED, c.authState.value)
        c.auth.end()
        Unit
    }

    @Test fun `a linked device unlinks only itself, then is wiped and logged out`() = runBlocking {
        val storage = storedSession()
        val c = sessionClient(url, storage, primaryDeviceId = other)
        assertTrue(c.auth.restore())

        assertTrue(runCatching { c.unlinkDevice(other) }.exceptionOrNull() is ObscuraError.NotPrimary)
        assertEquals(0, server.requestCount)

        server.enqueue(MockResponse.Builder().build())
        c.unlinkDevice(SELF_DEVICE_ID)

        assertEquals(listOf("/v1/devices/$SELF_DEVICE_ID"), paths())
        assertEquals(AuthState.LOGGED_OUT, c.authState.value)
        assertNull(storage.data)
        assertNull(c.devices.getIdentity())
        assertFalse(c.signalStore.hasIdentity())
    }
}
