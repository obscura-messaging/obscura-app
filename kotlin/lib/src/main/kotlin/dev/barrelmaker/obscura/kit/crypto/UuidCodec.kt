package dev.barrelmaker.obscura.kit.crypto

import com.google.protobuf.ByteString
import java.nio.ByteBuffer
import java.util.UUID

internal object UuidCodec {
    fun uuidToBytes(uuid: UUID): ByteString =
        ByteString.copyFrom(ByteBuffer.allocate(16).putLong(uuid.mostSignificantBits).putLong(uuid.leastSignificantBits).array())

    /** The canonical text form of a 16-byte UUID, or null for any other length. */
    fun uuidString(bytes: ByteString): String? {
        if (bytes.size() != 16) return null
        val buffer = bytes.asReadOnlyByteBuffer()
        return UUID(buffer.getLong(), buffer.getLong()).toString()
    }
}
