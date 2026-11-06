package dev.barrelmaker.obscura.kit

import dev.barrelmaker.obscura.kit.crypto.fromBase64
import dev.barrelmaker.obscura.kit.crypto.toBase64
import org.json.JSONObject

/** Base64 of `{"u": userId, "n": username}`. A pointer to a user, not a secret. */
internal object FriendCode {
    data class Decoded(val userId: String, val username: String)

    fun encode(userId: String, username: String): String =
        JSONObject().put("u", userId).put("n", username).toString().toByteArray().toBase64()

    /** Whitespace and soft hyphens (added by share sheets) are ignored; URL-safe Base64 is accepted. */
    fun decode(code: String): Decoded {
        val cleaned = code.filterNot { it.isWhitespace() || it == '\u00AD' }.replace('-', '+').replace('_', '/')
        val json = try {
            JSONObject(String(cleaned.fromBase64()))
        } catch (e: Exception) {
            throw ObscuraError.InvalidFriendCode()
        }
        val decoded = Decoded(json.optString("u"), json.optString("n"))
        if (decoded.userId.isBlank() || decoded.username.isBlank()) throw ObscuraError.InvalidFriendCode()
        return decoded
    }
}
