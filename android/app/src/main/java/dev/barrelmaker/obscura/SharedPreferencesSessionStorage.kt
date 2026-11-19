package dev.barrelmaker.obscura

import android.content.SharedPreferences
import android.util.Log
import org.json.JSONObject
import uniffi.obscura_core.ObscuraException
import uniffi.obscura_core.PersistedSession
import uniffi.obscura_core.SessionStorage

/**
 * The core's [SessionStorage]: the whole session as one JSON blob wrapped by [LocalKeystore],
 * because it holds the refresh token. [save] replaces the blob entirely.
 */
class SharedPreferencesSessionStorage(
    private val prefs: SharedPreferences
) : SessionStorage {

    override fun save(session: PersistedSession) {
        try {
            val json = JSONObject().apply {
                put("token", session.token)
                put("refreshToken", session.refreshToken)
                put("expiresAt", session.expiresAt)
                put("userId", session.userId)
                put("deviceId", session.deviceId)
                put("username", session.username)
            }
            // Synchronous: refresh tokens are single-use, so losing a write to process death means a 401.
            check(prefs.edit()
                .clear()
                .putString(BLOB, LocalKeystore.wrap(json.toString().toByteArray(Charsets.UTF_8)))
                .commit()) { "Could not persist the session" }
        } catch (e: ObscuraException) {
            throw e
        } catch (e: Exception) {
            throw ObscuraException.StorageFailed(e.message ?: "Session storage failed")
        }
    }

    override fun load(): PersistedSession? {
        val wrapped = prefs.getString(BLOB, null) ?: return null
        val plaintext = try {
            LocalKeystore.unwrap(wrapped)
        } catch (e: LocalKeystore.SecretUnavailableException) {
            Log.e(TAG, "session blob unreadable; signing out", e)
            clear()
            return null
        }
        try {
            val json = JSONObject(String(plaintext, Charsets.UTF_8))
            return PersistedSession(
                token = json.getString("token"),
                refreshToken = json.getString("refreshToken"),
                expiresAt = json.getLong("expiresAt"),
                userId = json.getString("userId"),
                deviceId = json.getString("deviceId"),
                username = json.getString("username"),
            )
        } catch (e: ObscuraException) {
            throw e
        } catch (e: Exception) {
            throw ObscuraException.StorageFailed(e.message ?: "Session storage failed")
        }
    }

    override fun clear() {
        try {
            check(prefs.edit().clear().commit()) { "Could not clear the session" }
        } catch (e: ObscuraException) {
            throw e
        } catch (e: Exception) {
            throw ObscuraException.StorageFailed(e.message ?: "Session storage failed")
        }
    }

    private companion object {
        const val TAG = "SessionStorage"
        const val BLOB = "session_blob"
    }
}
