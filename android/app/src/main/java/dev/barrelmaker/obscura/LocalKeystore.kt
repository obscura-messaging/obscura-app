package dev.barrelmaker.obscura

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Local secrets at rest, the Android counterpart of the iOS Keychain.
 *
 * One non-exportable AES-256-GCM key lives in the Android Keystore (hardware-backed where the
 * device has a TEE or StrongBox). It never encrypts data directly; it wraps small secrets, the
 * per-user database keys and the session blob, which are stored only in wrapped form.
 */
object LocalKeystore {

    private const val TAG = "LocalKeystore"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val WRAP_ALIAS = "obscura_local_wrap"
    private const val KEYS_PREFS = "obscura_db_keys"
    private const val GCM_IV_BYTES = 12
    private const val GCM_TAG_BITS = 128
    private val random = SecureRandom()

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(
                WRAP_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    /**
     * Encrypt with the Keystore key. Output is base64(iv || ciphertext+tag). An unusable Keystore
     * key is replaced: whatever it wrapped is already unreadable.
     */
    fun wrap(plaintext: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        try {
            cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        } catch (e: GeneralSecurityException) {
            Log.e(TAG, "Keystore wrap key unusable; replacing it", e)
            KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(WRAP_ALIAS)
            cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(plaintext), Base64.NO_WRAP)
    }

    /** @throws SecretUnavailableException if the secret cannot be recovered. */
    fun unwrap(wrapped: String): ByteArray {
        try {
            val bytes = Base64.decode(wrapped, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                wrapKey(),
                GCMParameterSpec(GCM_TAG_BITS, bytes, 0, GCM_IV_BYTES),
            )
            return cipher.doFinal(bytes, GCM_IV_BYTES, bytes.size - GCM_IV_BYTES)
        } catch (e: GeneralSecurityException) {
            throw SecretUnavailableException(e)
        } catch (e: IllegalArgumentException) {
            throw SecretUnavailableException(e) // malformed base64
        }
    }

    /** The Keystore key is gone or unusable, or the blob is corrupt. Not transient. */
    class SecretUnavailableException(cause: Throwable) :
        Exception("local secret could not be unwrapped", cause)

    /**
     * The SQLCipher key for one user's database: 32 random bytes, created on first use.
     */
    fun databaseKey(context: Context, username: String): ByteArray {
        val prefs = context.getSharedPreferences(KEYS_PREFS, Context.MODE_PRIVATE)
        val name = "db_$username"
        return prefs.getString(name, null)?.let { unwrap(it) }
            ?: ByteArray(32).also {
                random.nextBytes(it)
                check(prefs.edit().putString(name, wrap(it)).commit()) { "could not store database key" }
            }
    }

    /** Forget one user's database key and delete the database. */
    fun discardDatabase(context: Context, username: String, dbName: String) {
        context.getSharedPreferences(KEYS_PREFS, Context.MODE_PRIVATE)
            .edit().remove("db_$username").commit()
        context.deleteDatabase(dbName) // also removes -journal, -wal and -shm
    }
}
