package dev.barrelmaker.obscura.kit.network

import dev.barrelmaker.obscura.kit.ObscuraError
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal data class SignedPreKeyJson(val keyId: Int, val publicKey: String, val signature: String) {
    fun toJson(): JSONObject = JSONObject().put("keyId", keyId).put("publicKey", publicKey).put("signature", signature)
}

internal data class OneTimePreKeyJson(val keyId: Int, val publicKey: String) {
    fun toJson(): JSONObject = JSONObject().put("keyId", keyId).put("publicKey", publicKey)
}

/** The prekeys a device publishes on every refill. The identity key cannot change there. */
internal data class PreKeyUpload(val signedPreKey: SignedPreKeyJson, val oneTimePreKeys: List<OneTimePreKeyJson>) {
    fun toJson(): JSONObject = JSONObject()
        .put("signedPreKey", signedPreKey.toJson())
        .put("oneTimePreKeys", JSONArray(oneTimePreKeys.map { it.toJson() }))
}

/** The key material a device publishes when it is created. */
internal data class DeviceKeys(val identityKey: String, val registrationId: Int, val preKeys: PreKeyUpload) {
    fun toJson(): JSONObject = preKeys.toJson()
        .put("identityKey", identityKey)
        .put("registrationId", registrationId)
}

internal data class AuthResponse(
    val token: String,
    val refreshToken: String,
    val expiresAt: Long,
    val userId: String,
    val deviceId: String,
) {
    companion object {
        fun from(json: JSONObject): AuthResponse {
            val token = json.optString("token")
            val refreshToken = json.optString("refreshToken")
            val expiresAt = json.optLong("expiresAt")
            val userId = json.optString("userId")
            val deviceId = json.optString("deviceId")
            if (token.isBlank() || refreshToken.isBlank() || expiresAt <= 0 || !isUuid(userId) || !isUuid(deviceId)) {
                throw ObscuraError.ProtocolViolation("Invalid auth response")
            }
            return AuthResponse(token, refreshToken, expiresAt, userId, deviceId)
        }
    }
}

/** One device of the signed-in account, from `GET /v1/devices`. */
internal data class OwnDevice(val deviceId: String, val name: String?, val isPrimary: Boolean)

internal data class LinkSession(val id: String, val userId: String, val expiresAt: Long)

internal fun isUuid(value: String): Boolean = runCatching { UUID.fromString(value).toString() == value.lowercase() }.getOrDefault(false)
