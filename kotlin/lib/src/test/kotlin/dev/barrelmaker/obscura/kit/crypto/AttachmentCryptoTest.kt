package dev.barrelmaker.obscura.kit.crypto

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class AttachmentCryptoTest {

    @Test
    fun `encrypt decrypt round-trips arbitrary bytes`() {
        val plaintext = ByteArray(4096) { (it % 256).toByte() }
        val enc = AttachmentCrypto.encrypt(plaintext)

        val decoded = AttachmentCrypto.decrypt(enc.ciphertext, enc.contentKey, enc.nonce)
        assertArrayEquals(plaintext, decoded)
    }

    @Test
    fun `encrypt produces 32-byte key and 12-byte nonce`() {
        val enc = AttachmentCrypto.encrypt(byteArrayOf(1, 2, 3))
        assertEquals(32, enc.contentKey.size, "AES-256 key must be 32 bytes")
        assertEquals(12, enc.nonce.size, "GCM standard nonce is 12 bytes")
    }

    @Test
    fun `encrypt produces fresh key and nonce each call (CSPRNG)`() {
        val a = AttachmentCrypto.encrypt("hi".toByteArray())
        val b = AttachmentCrypto.encrypt("hi".toByteArray())
        assertNotEquals(a.contentKey.toList(), b.contentKey.toList())
        assertNotEquals(a.nonce.toList(), b.nonce.toList())
        assertNotEquals(a.ciphertext.toList(), b.ciphertext.toList())
    }

    @Test
    fun `decrypt with wrong key throws`() {
        val enc = AttachmentCrypto.encrypt("secret".toByteArray())
        val wrongKey = ByteArray(32) { 0x42 }
        assertThrows(Exception::class.java) {
            AttachmentCrypto.decrypt(enc.ciphertext, wrongKey, enc.nonce)
        }
    }

    @Test
    fun `decrypt with wrong nonce throws`() {
        val enc = AttachmentCrypto.encrypt("secret".toByteArray())
        val wrongNonce = ByteArray(12) { 0x01 }
        assertThrows(Exception::class.java) {
            AttachmentCrypto.decrypt(enc.ciphertext, enc.contentKey, wrongNonce)
        }
    }

    @Test
    fun `decrypt of tampered ciphertext throws (AEAD check)`() {
        val enc = AttachmentCrypto.encrypt("important".toByteArray())
        val tampered = enc.ciphertext.copyOf()
        tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
        assertThrows(Exception::class.java) {
            AttachmentCrypto.decrypt(tampered, enc.contentKey, enc.nonce)
        }
    }

    @Test
    fun `handles empty plaintext`() {
        val enc = AttachmentCrypto.encrypt(ByteArray(0))
        val decoded = AttachmentCrypto.decrypt(enc.ciphertext, enc.contentKey, enc.nonce)
        assertEquals(0, decoded.size)
    }
}
