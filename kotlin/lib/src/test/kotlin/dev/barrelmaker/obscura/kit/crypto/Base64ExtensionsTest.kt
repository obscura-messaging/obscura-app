package dev.barrelmaker.obscura.kit.crypto

import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class Base64ExtensionsTest {

    @Test
    fun `round-trips ASCII bytes`() {
        val input = "hello world".toByteArray()
        val encoded = input.toBase64()
        assertArrayEquals(input, encoded.fromBase64())
    }

    @Test
    fun `round-trips arbitrary binary including 0xFF and 0x00`() {
        val input = ByteArray(256) { it.toByte() }
        assertArrayEquals(input, input.toBase64().fromBase64())
    }

    @Test
    fun `empty array round-trips`() {
        assertEquals("", ByteArray(0).toBase64())
        assertArrayEquals(ByteArray(0), "".fromBase64())
    }

    @Test
    fun `standard encoder produces padding`() {
        assertEquals("AQ==", byteArrayOf(0x01).toBase64())
    }

    @Test
    fun `url decoder accepts dash and underscore variants`() {
        val payload = byteArrayOf(0xFB.toByte(), 0xFF.toByte(), 0xBF.toByte())
        val urlSafe = java.util.Base64.getUrlEncoder().encodeToString(payload)
        assertArrayEquals(payload, urlSafe.fromBase64Url())
    }

    @Test
    fun `fromBase64 on garbage throws`() {
        assertThrows(IllegalArgumentException::class.java) {
            "this is not base64!".fromBase64()
        }
    }
}
