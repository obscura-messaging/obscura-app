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

internal data class KyberPreKeyJson(val keyId: Int, val publicKey: String, val signature: String) {
    fun toJson(): JSONObject = JSONObject().put("keyId", keyId).put("publicKey", publicKey).put("signature", signature)
}

/**
 * A pre-key upload to `POST /v1/keys`. Each part present replaces what the server holds of that kind;
 * absent parts are left as they are. The identity key cannot change here.
 */
internal data class PreKeyUpload(
    val signedPreKey: SignedPreKeyJson?,
    val lastResortKyberPreKey: KyberPreKeyJson?,
    val oneTimePreKeys: List<OneTimePreKeyJson>,
    val kyberPreKeys: List<KyberPreKeyJson>,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        signedPreKey?.let { put("signedPreKey", it.toJson()) }
        lastResortKyberPreKey?.let { put("lastResortKyberPreKey", it.toJson()) }
        if (oneTimePreKeys.isNotEmpty()) put("oneTimePreKeys", JSONArray(oneTimePreKeys.map { it.toJson() }))
        if (kyberPreKeys.isNotEmpty()) put("kyberPreKeys", JSONArray(kyberPreKeys.map { it.toJson() }))
    }
}

/** The key material a device publishes when it is created; every part is required. */
internal data class DeviceKeys(
    val identityKey: String,
    val registrationId: Int,
    val signedPreKey: SignedPreKeyJson,
    val lastResortKyberPreKey: KyberPreKeyJson,
    val oneTimePreKeys: List<OneTimePreKeyJson>,
    val kyberPreKeys: List<KyberPreKeyJson>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("identityKey", identityKey)
        .put("registrationId", registrationId)
        .put("signedPreKey", signedPreKey.toJson())
        .put("lastResortKyberPreKey", lastResortKyberPreKey.toJson())
        .put("oneTimePreKeys", JSONArray(oneTimePreKeys.map { it.toJson() }))
        .put("kyberPreKeys", JSONArray(kyberPreKeys.map { it.toJson() }))
}

/** How many one-time pre-keys of each kind the server still holds for this device, from `GET /v1/keys`. */
internal data class PreKeyCounts(val oneTime: Int, val kyber: Int) {
    companion object {
        fun from(json: JSONObject) = PreKeyCounts(json.getInt("oneTimePreKeyCount"), json.getInt("kyberPreKeyCount"))
    }
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
