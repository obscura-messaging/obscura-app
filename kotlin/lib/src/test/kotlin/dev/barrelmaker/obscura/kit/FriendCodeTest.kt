package dev.barrelmaker.obscura.kit

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class FriendCodeTest {

    @Test
    fun `round-trips a normal userId and username`() {
        val encoded = FriendCode.encode("019f025a-3745-7de6-84b6-d932cae7d45f", "alice")
        val decoded = FriendCode.decode(encoded)
        assertEquals("019f025a-3745-7de6-84b6-d932cae7d45f", decoded.userId)
        assertEquals("alice", decoded.username)
    }

    @Test
    fun `round-trips a username with unicode`() {
        val encoded = FriendCode.encode("uid", "✨nolan✨")
        val decoded = FriendCode.decode(encoded)
        assertEquals("✨nolan✨", decoded.username)
    }

    @Test
    fun `decode ignores whitespace and soft hyphens anywhere`() {
        val encoded = FriendCode.encode("uid", "alice")
        val decoded = FriendCode.decode("  \n${encoded.take(4)}\u00AD ${encoded.drop(4)}\t  ")
        assertEquals("alice", decoded.username)
    }

    @Test
    fun `decode normalises url-safe base64`() {
        val encoded = FriendCode.encode("uid", "alice")
        val urlSafe = encoded.replace('+', '-').replace('/', '_')
        val decoded = FriendCode.decode(urlSafe)
        assertEquals("alice", decoded.username)
    }

    @Test
    fun `decode rejects empty string`() {
        assertThrows(Exception::class.java) { FriendCode.decode("") }
    }

    @Test
    fun `decode rejects non-base64 garbage`() {
        assertThrows(Exception::class.java) { FriendCode.decode("not a friend code!!!") }
    }

    @Test
    fun `decode rejects payload missing required fields`() {
        val empty = java.util.Base64.getEncoder().encodeToString("{}".toByteArray())
        assertThrows(ObscuraError.InvalidFriendCode::class.java) { FriendCode.decode(empty) }
    }
}
