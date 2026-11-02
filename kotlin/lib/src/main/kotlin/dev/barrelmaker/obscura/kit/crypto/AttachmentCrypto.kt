package dev.barrelmaker.obscura.kit.crypto

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** AES-256-GCM, no associated data, the 16-byte tag appended. Attachments get a random key and nonce each. */
internal object AttachmentCrypto {
    private const val KEY_SIZE = 32
    const val NONCE_SIZE = 12
    private const val GCM_TAG_BITS = 128
    private val random = SecureRandom()

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
}
