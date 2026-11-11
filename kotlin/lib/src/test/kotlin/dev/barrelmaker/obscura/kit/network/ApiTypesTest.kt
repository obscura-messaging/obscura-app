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
    fun `device keys carry every kind of pre-key`() {
        val json = DeviceKeys(
            identityKey = "idk",
            registrationId = 100,
            signedPreKey = SignedPreKeyJson(1, "spk", "sig"),
            lastResortKyberPreKey = KyberPreKeyJson(3, "lrk", "lrsig"),
            oneTimePreKeys = listOf(OneTimePreKeyJson(2, "otk")),
            kyberPreKeys = listOf(KyberPreKeyJson(4, "kpk", "ksig")),
        ).toJson()

        assertEquals(
            setOf("identityKey", "registrationId", "signedPreKey", "lastResortKyberPreKey", "oneTimePreKeys", "kyberPreKeys"),
            json.keySet(),
        )
        assertEquals(100, json.getInt("registrationId"))
        assertEquals("sig", json.getJSONObject("signedPreKey").getString("signature"))
        assertEquals("lrsig", json.getJSONObject("lastResortKyberPreKey").getString("signature"))
        assertEquals(2, json.getJSONArray("oneTimePreKeys").getJSONObject(0).getInt("keyId"))
        assertEquals("otk", json.getJSONArray("oneTimePreKeys").getJSONObject(0).getString("publicKey"))
        assertEquals("ksig", json.getJSONArray("kyberPreKeys").getJSONObject(0).getString("signature"))
    }

    @Test
    fun `an upload sends only the parts it has`() {
        assertEquals(emptySet<String>(), PreKeyUpload(null, null, emptyList(), emptyList()).toJson().keySet())
        val json = PreKeyUpload(null, KyberPreKeyJson(3, "lrk", "lrsig"), listOf(OneTimePreKeyJson(2, "otk")), emptyList()).toJson()
        assertEquals(setOf("lastResortKyberPreKey", "oneTimePreKeys"), json.keySet())
    }

    @Test
    fun `pre-key counts read both kinds`() {
        assertEquals(PreKeyCounts(7, 3), PreKeyCounts.from(JSONObject("""{"oneTimePreKeyCount":7,"kyberPreKeyCount":3}""")))
    }

    @Test
    fun `an auth response requires token, refreshToken, expiresAt, userId and deviceId`() {
        val valid = AuthResponse.from(
            JSONObject("""{"token":"t","refreshToken":"r","expiresAt":$FAR_FUTURE,"userId":"$SELF_USER_ID","deviceId":"$SELF_DEVICE_ID"}""")
        )
        assertEquals(AuthResponse("t", "r", FAR_FUTURE, SELF_USER_ID, SELF_DEVICE_ID), valid)
        for (invalid in listOf(
            """{"token":"","refreshToken":"r","expiresAt":1,"userId":"$SELF_USER_ID","deviceId":"$SELF_DEVICE_ID"}""",
            """{"token":"t","refreshToken":"","expiresAt":1,"userId":"$SELF_USER_ID","deviceId":"$SELF_DEVICE_ID"}""",
            """{"token":"t","refreshToken":"r","expiresAt":0,"userId":"$SELF_USER_ID","deviceId":"$SELF_DEVICE_ID"}""",
            """{"token":"t","refreshToken":"r","expiresAt":1,"userId":"not-a-uuid","deviceId":"$SELF_DEVICE_ID"}""",
            """{"token":"t","refreshToken":"r","expiresAt":1,"userId":"$SELF_USER_ID","deviceId":"not-a-uuid"}""",
        )) {
            assertThrows(ObscuraError.ProtocolViolation::class.java, { AuthResponse.from(JSONObject(invalid)) }, invalid)
        }
    }
}
