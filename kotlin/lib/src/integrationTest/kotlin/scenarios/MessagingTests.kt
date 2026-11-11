package scenarios

import dev.barrelmaker.obscura.kit.crypto.fromBase64
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.DirectMessage
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MessagingTests {

    @Test
    fun `messages arrive with authenticated identity, in both directions, and announce their model`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("msg_a")
        val bob = registerAndConnect("msg_b")
        becomeFriends(alice, bob)

        val id = alice.sendMessage(bob.userId!!, "hello bob")

        val row = bob.awaitRow { it.id == id }
        assertEquals("message", row.kind)
        assertEquals(alice.userId, row.authorUserId)
        assertEquals(alice.userId, row.peerUserId)
        assertEquals("hello bob", row.content)
        assertEquals("directMessage", withTimeout(5_000) { bob.messageReceived.receive() })

        sendAndVerify(bob, alice, "reply")
        assertEquals(2, bob.getMessages().size)
        assertEquals(2, alice.getMessages().size)
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `a far-future timestamp is clamped before it is stored`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("clamp_a")
        val bob = registerAndConnect("clamp_b")
        becomeFriends(alice, bob)
        val before = System.currentTimeMillis()

        val futureMsg = ClientMessage.newBuilder()
            .setTimestamp(Long.MAX_VALUE)
            .setDirectMessage(
                DirectMessage.newBuilder()
                    .setId("future_1")
                    .setPeerUserId(bob.userId!!)
                    .setContent("from the far future"),
            )
            .build()
        alice.sender.send(listOf(bob.userId!!), futureMsg)

        val row = bob.awaitContent("from the far future")
        assertTrue(row.sentAt in 1..before + 120_000, "sentAt was ${row.sentAt}")
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `messages sent while offline arrive on reconnect in order`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("offline_a")
        val bob = registerAndConnect("offline_b")
        becomeFriends(alice, bob)

        bob.disconnect()
        sendText(alice, bob, "one")
        sendText(alice, bob, "two")
        bob.connect()

        eventually { bob.getMessages().size == 2 }
        assertEquals(listOf("one", "two"), bob.getMessages().map { it.content })
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `a story references an attachment the friend can download`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("story_a")
        val bob = registerAndConnect("story_b")
        becomeFriends(alice, bob)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte()) + ByteArray(250)

        val attachment = alice.uploadAttachment(jpeg)
        alice.postStory("vacation", attachment.media("photo"), null)

        eventually { bob.getStories().isNotEmpty() }
        val story = bob.getStories().single()
        assertEquals("vacation", story.content)
        val att = story.attachment!!
        assertArrayEquals(
            jpeg,
            bob.downloadDecryptedAttachment(att.id, att.contentKey, att.nonce),
        )
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `attachments round-trip and the server holds only ciphertext`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("att")
        for (size in listOf(0, 100, 500 * 1024)) {
            val plaintext = ByteArray(size) { (it % 256).toByte() }
            val attachment = alice.uploadAttachment(plaintext)
            assertTrue(attachment.id.isNotEmpty())
            val stored = alice.api.fetchAttachment(attachment.id)
            assertTrue(!stored.contentEquals(plaintext), "server must never receive plaintext")
            assertArrayEquals(plaintext, alice.downloadDecryptedAttachment(attachment.id, attachment.contentKey, attachment.nonce))
        }
        alice.disconnect()
    }

    @Test
    fun `registering a push token is idempotent`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("push_reg")
        alice.registerPushToken("test-token-1")
        alice.registerPushToken("test-token-2")
        alice.disconnect()
    }

    @Test
    fun `connection survives longer than the keepalive interval`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("idle_a")
        val bob = registerAndConnect("idle_b")
        becomeFriends(alice, bob)

        delay(35_000)

        sendAndVerify(alice, bob, "after 35s idle")
        alice.disconnect(); bob.disconnect()
    }
}
