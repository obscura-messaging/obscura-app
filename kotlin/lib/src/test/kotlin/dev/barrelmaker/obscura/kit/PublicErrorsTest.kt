package dev.barrelmaker.obscura.kit

import kotlinx.coroutines.runBlocking
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PublicErrorsTest {
    @Test fun `purposeful errors have the exact shared codes and preserve storage cause`() {
        val cause = IllegalStateException("disk")
        val errors = listOf(
            ObscuraError.NotAuthenticated() to "NOT_AUTHENTICATED",
            ObscuraError.InvalidArgument("argument") to "INVALID_ARGUMENT",
            ObscuraError.InvalidFriendCode() to "INVALID_FRIEND_CODE",
            ObscuraError.Http(400, "body") to "HTTP_ERROR",
            ObscuraError.ConnectionFailed("connection") to "CONNECTION_FAILED",
            ObscuraError.SendFailed("send") to "SEND_FAILED",
            ObscuraError.ProtocolViolation("protocol") to "PROTOCOL_VIOLATION",
            ObscuraError.NotPrimary() to "NOT_PRIMARY",
            ObscuraError.LinkFailed("link") to "LINK_FAILED",
            ObscuraError.StorageFailed("storage", cause) to "STORAGE_ERROR",
        )
        errors.forEach { (error, code) -> assertEquals(code, error.code) }
        assertSame(cause, errors.last().first.cause)
    }

    @Test fun `blank authentication arguments fail before network`() = runBlocking {
        val c = newClient()
        for (call in listOf<suspend () -> Unit>(
            { c.login(" ", "password") },
            { c.register("user", "") },
            { c.resetAccount("user", " ") },
            { c.beginLink("", "password", "Tablet") },
        )) assertTrue(runCatching { call() }.exceptionOrNull() is ObscuraError.InvalidArgument)
    }

    @Test fun `invalid friend codes consistently use INVALID_FRIEND_CODE`() {
        for (code in listOf("", "not base64!", FriendCode.encode(" ", "name"), FriendCode.encode("id", " "))) {
            val error = runCatching { FriendCode.decode(code) }.exceptionOrNull()
            assertTrue(error is ObscuraError.InvalidFriendCode, "$code: $error")
        }
    }

    @Test fun `blank configuration and malformed HTTPS addresses use INVALID_ARGUMENT`() {
        for (url in listOf("https://", "https://user@host.test", "https://host.test:99999", "https://host.test#fragment")) {
            assertThrows(ObscuraError.InvalidArgument::class.java) { ObscuraConfig(url, "device") }
        }
        assertThrows(ObscuraError.InvalidArgument::class.java) { ObscuraConfig("https://host.test", " ") }
        assertThrows(ObscuraError.InvalidArgument::class.java) { ObscuraConfig("https://host.test", "device", " ") }
    }

    @Test fun `provisioning without a device id is protocol violation not a runtime assertion`() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val url = server.url("/").toString()
            val c = newClient(url)
            val response = """{"token":"t","refreshToken":"rt","expiresAt":$FAR_FUTURE,"userId":"$SELF_USER_ID"}"""
            server.enqueue(MockResponse.Builder().body(response).build())
            val error = runCatching { c.register("user", "password") }.exceptionOrNull()
            assertTrue(error is ObscuraError.ProtocolViolation)
            assertEquals(AuthState.LOGGED_OUT, c.authState.value)
            assertNull(c.devices.getIdentity())
            assertFalse(c.signalStore.hasIdentity())
            assertEquals("/v1/users", server.takeRequest().url.encodedPath)
        }
    }

    @Test fun `provisioning cannot overwrite an existing device or Signal identity`() = runBlocking {
        val c = sessionClient("http://127.0.0.1:1", storedSession())
        val identity = c.signalStore.identityKeyPair.serialize()
        val error = runCatching { c.register("user", "password") }.exceptionOrNull()
        assertTrue(error is ObscuraError.InvalidArgument)
        assertEquals(SELF_DEVICE_ID, c.devices.getIdentity())
        assertArrayEquals(identity, c.signalStore.identityKeyPair.serialize())
    }
}
