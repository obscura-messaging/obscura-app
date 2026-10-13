package dev.barrelmaker.obscura

import android.content.SharedPreferences
import android.util.Log
import dev.barrelmaker.obscura.kit.persistence.SessionStorage
import org.json.JSONObject

/**
 * The kit's [SessionStorage]: the whole session as one JSON blob wrapped by [LocalKeystore],
 * because it holds the refresh token. [save] replaces the blob entirely.
 */
class SharedPreferencesSessionStorage(
    private val prefs: SharedPreferences
) : SessionStorage {

    override fun save(data: Map<String, String>) {
        val json = JSONObject(data)
        // Synchronous: refresh tokens are single-use, so losing a write to process death means a 401.
        check(prefs.edit()
            .clear()
            .putString(BLOB, LocalKeystore.wrap(json.toString().toByteArray(Charsets.UTF_8)))
            .commit()) { "Could not persist the session" }
    }

    override fun load(): Map<String, String>? {
        val wrapped = prefs.getString(BLOB, null) ?: return null
        val plaintext = try {
            LocalKeystore.unwrap(wrapped)
        } catch (e: LocalKeystore.SecretUnavailableException) {
            Log.e(TAG, "session blob unreadable; signing out", e)
            clear()
            return null
        }
        val json = JSONObject(String(plaintext, Charsets.UTF_8))
        return json.keys().asSequence().associateWith { key ->
            val value = json.get(key)
            require(value is String) { "Session field $key is not a string" }
            value
        }
    }

    override fun clear() {
        check(prefs.edit().clear().commit()) { "Could not clear the session" }
    }

    private companion object {
        const val TAG = "SessionStorage"
        const val BLOB = "session_blob"
    }
}
