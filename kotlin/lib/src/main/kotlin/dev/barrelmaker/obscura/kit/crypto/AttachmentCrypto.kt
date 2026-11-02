package dev.barrelmaker.obscura.kit.crypto

import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM, no associated data, the 16-byte tag appended. Attachments get a random key and nonce each. */
object AttachmentCrypto {
    private const val KEY_SIZE = 32
    const val NONCE_SIZE = 12
    private const val GCM_TAG_BITS = 128
    private val random = SecureRandom()
    private val EXTENSIONS = listOf("jpg", "mp4", "mov")

    class Encrypted(val ciphertext: ByteArray, val contentKey: ByteArray, val nonce: ByteArray)

    fun encrypt(plaintext: ByteArray): Encrypted {
        val contentKey = ByteArray(KEY_SIZE).also(random::nextBytes)
        val nonce = randomNonce()
        return Encrypted(encrypt(plaintext, contentKey, nonce), contentKey, nonce)
    }

    fun encrypt(plaintext: ByteArray, key: ByteArray, nonce: ByteArray): ByteArray =
        cipher(Cipher.ENCRYPT_MODE, key, nonce).doFinal(plaintext)

    /** Throws on a wrong key or tampered ciphertext. */
    fun decrypt(ciphertext: ByteArray, contentKey: ByteArray, nonce: ByteArray): ByteArray =
        cipher(Cipher.DECRYPT_MODE, contentKey, nonce).doFinal(ciphertext)

    fun randomNonce(): ByteArray = ByteArray(NONCE_SIZE).also(random::nextBytes)

    private fun cipher(mode: Int, key: ByteArray, nonce: ByteArray) = Cipher.getInstance("AES/GCM/NoPadding")
        .apply { init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, nonce)) }

    private fun safeStem(id: String) = id.replace(Regex("[^A-Za-z0-9_-]"), "_")

    /** Return an existing non-empty cached attachment file for [id] in [cacheDir], or null. */
    fun readCached(cacheDir: File, id: String): File? {
        val safe = safeStem(id)
        for (ext in EXTENSIONS) {
            val f = File(cacheDir, "$safe.$ext")
            if (f.exists() && f.length() > 0L) return f
        }
        return null
    }

    /**
     * Atomically write [data] to [cacheDir] named after [id] with an extension sniffed
     * from magic bytes so media players that dispatch on suffix can decode.
     */
    fun writeCached(cacheDir: File, id: String, data: ByteArray): File {
        cacheDir.mkdirs()
        val safe = safeStem(id)
        val ext = if (data.size >= 12 &&
            data[4] == 0x66.toByte() && data[5] == 0x74.toByte() &&
            data[6] == 0x79.toByte() && data[7] == 0x70.toByte()
        ) {
            if (String(data, 8, 4, Charsets.US_ASCII) == "qt  ") "mov" else "mp4"
        } else "jpg"
        val dest = File(cacheDir, "$safe.$ext")
        val tmp = File(cacheDir, "$safe.$ext.tmp")
        try {
            tmp.writeBytes(data)
            if (!tmp.renameTo(dest)) {
                tmp.copyTo(dest, overwrite = true)
            }
        } finally {
            tmp.delete()
        }
        return dest
    }

    /** Delete any cached attachment files for [id] in [cacheDir]. */
    fun purgeCached(cacheDir: File, id: String) {
        val stem = safeStem(id)
        for (ext in EXTENSIONS) {
            File(cacheDir, "$stem.$ext").delete()
            File(cacheDir, "$stem.$ext.tmp").delete()
        }
    }
}
