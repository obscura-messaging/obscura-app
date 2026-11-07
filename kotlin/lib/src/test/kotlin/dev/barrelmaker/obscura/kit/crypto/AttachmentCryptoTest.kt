package dev.barrelmaker.obscura.kit.crypto

import dev.barrelmaker.obscura.kit.AttachmentUpload
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.util.UUID

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

    @Test
    fun `AttachmentUpload compares contentKey and nonce by value`() {
        val a = AttachmentUpload("att_1", byteArrayOf(1, 2, 3), byteArrayOf(4, 5))
        val b = AttachmentUpload("att_1", byteArrayOf(1, 2, 3), byteArrayOf(4, 5))
        assertTrue(a.equals(a))
        assertFalse(a.equals("not-an-upload"))
        assertFalse(a.equals(null))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
        assertNotEquals(a, AttachmentUpload("att_2", byteArrayOf(1, 2, 3), byteArrayOf(4, 5)))
        assertNotEquals(a, AttachmentUpload("att_1", byteArrayOf(9, 2, 3), byteArrayOf(4, 5)))
        assertNotEquals(a, AttachmentUpload("att_1", byteArrayOf(1, 2, 3), byteArrayOf(9, 5)))
    }

    @Test
    fun `writeCached readCached and purgeCached sniff jpg mp4 and mov magic bytes and sanitize id`() {
        val cacheDir = File("build/test-databases/att-cache-${UUID.randomUUID()}")
        try {
            val jpgBytes = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte(), 1, 2, 3)
            val mp4Bytes = byteArrayOf(0, 0, 0, 24) + "ftypisom".toByteArray(Charsets.US_ASCII) + byteArrayOf(9, 9)
            val movBytes = byteArrayOf(0, 0, 0, 20) + "ftypqt  ".toByteArray(Charsets.US_ASCII) + byteArrayOf(7, 7)

            assertNull(AttachmentCrypto.readCached(cacheDir, "att_jpg"))

            val jpgFile = AttachmentCrypto.writeCached(cacheDir, "att/jpg:1", jpgBytes)
            assertEquals("att_jpg_1.jpg", jpgFile.name)
            assertArrayEquals(jpgBytes, jpgFile.readBytes())
            assertFalse(File(cacheDir, "att_jpg_1.jpg.tmp").exists())
            assertEquals(jpgFile.absolutePath, AttachmentCrypto.readCached(cacheDir, "att/jpg:1")?.absolutePath)

            val mp4File = AttachmentCrypto.writeCached(cacheDir, "att_mp4", mp4Bytes)
            assertEquals("att_mp4.mp4", mp4File.name)
            assertArrayEquals(mp4Bytes, mp4File.readBytes())
            assertEquals(mp4File.absolutePath, AttachmentCrypto.readCached(cacheDir, "att_mp4")?.absolutePath)

            val movFile = AttachmentCrypto.writeCached(cacheDir, "att_mov", movBytes)
            assertEquals("att_mov.mov", movFile.name)
            assertArrayEquals(movBytes, movFile.readBytes())
            assertEquals(movFile.absolutePath, AttachmentCrypto.readCached(cacheDir, "att_mov")?.absolutePath)

            // 12+ byte payloads that partially match "ftyp" still fall back to jpg
            for (partial in listOf(
                ByteArray(12),
                byteArrayOf(0, 0, 0, 0, 'f'.code.toByte(), 0, 0, 0, 0, 0, 0, 0),
                byteArrayOf(0, 0, 0, 0, 'f'.code.toByte(), 't'.code.toByte(), 0, 0, 0, 0, 0, 0),
                byteArrayOf(0, 0, 0, 0, 'f'.code.toByte(), 't'.code.toByte(), 'y'.code.toByte(), 0, 0, 0, 0, 0),
            )) {
                assertEquals("jpg", AttachmentCrypto.writeCached(cacheDir, "att_partial", partial).extension)
            }

            // Fallback to copyTo when renameTo fails (e.g. dest is an existing empty directory)
            val fallbackDest = File(cacheDir, "att_fallback.jpg").also { it.mkdirs() }
            assertTrue(fallbackDest.isDirectory)
            val fallbackWritten = AttachmentCrypto.writeCached(cacheDir, "att_fallback", jpgBytes)
            assertTrue(fallbackWritten.isFile)
            assertArrayEquals(jpgBytes, fallbackWritten.readBytes())

            // Empty file is ignored by readCached
            File(cacheDir, "att_empty.jpg").writeBytes(ByteArray(0))
            assertNull(AttachmentCrypto.readCached(cacheDir, "att_empty"))

            // purgeCached deletes both main and leftover .tmp files across all extensions
            File(cacheDir, "att_mp4.mp4.tmp").writeBytes(byteArrayOf(1))
            File(cacheDir, "att_mp4.mp4.uuid.tmp").writeBytes(byteArrayOf(1))
            File(cacheDir, "att_mp4.keep").writeBytes(byteArrayOf(1))
            AttachmentCrypto.purgeCached(cacheDir, "att/jpg:1")
            AttachmentCrypto.purgeCached(cacheDir, "att_mp4")
            AttachmentCrypto.purgeCached(File(cacheDir, "nonexistent"), "att_mp4")

            assertNull(AttachmentCrypto.readCached(cacheDir, "att/jpg:1"))
            assertNull(AttachmentCrypto.readCached(cacheDir, "att_mp4"))
            assertFalse(File(cacheDir, "att_mp4.mp4.tmp").exists())
            assertFalse(File(cacheDir, "att_mp4.mp4.uuid.tmp").exists())
            assertTrue(File(cacheDir, "att_mp4.keep").exists())

            // purgeAllCached deletes all remaining files in cacheDir
            assertTrue(movFile.exists())
            AttachmentCrypto.purgeAllCached(cacheDir)
            AttachmentCrypto.purgeAllCached(File(cacheDir, "nonexistent"))
            assertNull(AttachmentCrypto.readCached(cacheDir, "att_mov"))
        } finally {
            cacheDir.deleteRecursively()
        }
    }
}
