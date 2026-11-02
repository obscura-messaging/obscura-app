package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.FAR_FUTURE
import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.SELF_DEVICE_ID
import dev.barrelmaker.obscura.kit.SELF_USER_ID
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

/** The JSON shapes the server expects and returns. */
class ApiTypesTest {

    @Test
    fun `device keys nest the signed prekey and one-time prekeys`() {
        val json = DeviceKeys(
            identityKey = "idk",
            registrationId = 100,
            preKeys = PreKeyUpload(SignedPreKeyJson(1, "spk", "sig"), listOf(OneTimePreKeyJson(2, "otk"))),
        ).toJson()

        assertEquals(setOf("identityKey", "registrationId", "signedPreKey", "oneTimePreKeys"), json.keySet())
        assertEquals(100, json.getInt("registrationId"))
        assertEquals("sig", json.getJSONObject("signedPreKey").getString("signature"))
        assertEquals(2, json.getJSONArray("oneTimePreKeys").getJSONObject(0).getInt("keyId"))
        assertEquals("otk", json.getJSONArray("oneTimePreKeys").getJSONObject(0).getString("publicKey"))
    }

    @Test
    fun `an auth response requires token, refreshToken, expiresAt, userId and deviceId`() {
        val valid = AuthResponse.from(
            JSONObject("""{"token":"t","refreshToken":"r","expiresAt":$FAR_FUTURE,"userId":"$SELF_USER_ID","deviceId":"$SELF_DEVICE_ID"}""")
        )
        assertEquals(AuthResponse("t", "r", FAR_FUTURE, SELF_USER_ID, SELF_DEVICE_ID), valid)
        assertThrows(ObscuraError.ProtocolViolation::class.java) {
            AuthResponse.from(JSONObject("""{"token":"t","refreshToken":"r","expiresAt":1}"""))
        }
    }

    @Test
    fun `Retry-After is whole seconds clamped to 1 through 10`() {
        assertEquals(1_000L, APIClient.retryAfterMs(null))
        assertEquals(1_000L, APIClient.retryAfterMs("soon"))
        assertEquals(1_000L, APIClient.retryAfterMs("0"))
        assertEquals(3_000L, APIClient.retryAfterMs(" 3 "))
        assertEquals(10_000L, APIClient.retryAfterMs("60"))
    }
}
