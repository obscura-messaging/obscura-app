package dev.barrelmaker.obscura.kit.crypto

import com.google.protobuf.ByteString
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.UUID

class UuidCodecTest {

    @Test
    fun `round-trips uuids including nil and max`() {
        for (uuid in List(20) { UUID.randomUUID() } + UUID(0, 0) + UUID(-1L, -1L)) {
            val bytes = UuidCodec.uuidToBytes(uuid)
            assertEquals(16, bytes.size())
            assertEquals(uuid.toString(), UuidCodec.uuidString(bytes))
        }
    }

    @Test
    fun `any length other than 16 has no uuid`() {
        assertNull(UuidCodec.uuidString(ByteString.EMPTY))
        assertNull(UuidCodec.uuidString(ByteString.copyFrom(ByteArray(15))))
        assertNull(UuidCodec.uuidString(ByteString.copyFrom(ByteArray(17))))
    }

    @Test
    fun `encoding is big-endian most-then-least`() {
        val bytes = UuidCodec.uuidToBytes(UUID(0x0123456789ABCDEFL, 0xFEDCBA9876543210uL.toLong())).toByteArray()
        assertEquals(0x01.toByte(), bytes[0])
        assertEquals(0xEF.toByte(), bytes[7])
        assertEquals(0xFE.toByte(), bytes[8])
        assertEquals(0x10.toByte(), bytes[15])
    }
}
