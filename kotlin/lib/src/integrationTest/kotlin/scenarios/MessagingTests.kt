package scenarios

import dev.barrelmaker.obscura.kit.SubmissionStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MessagingTests {

    @Test
    fun `entries arrive byte-identical with authenticated identity, in both directions, and announce their model`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("msg_a")
        val bob = registerAndConnect("msg_b")
        becomeFriends(alice, bob)

        val payload = """{"content":"opaque to the kit","expiresAt":123}""".toByteArray()
        val report = alice.send(listOf(bob.userId!!), "directMessage", "dm_1", 1_700_000_000_000, payload)
        assertEquals(listOf(SubmissionStatus.ACCEPTED), report.recipients.map { it.status })
        assertEquals(emptyList<Any>(), report.selfSync, "a single-device sender has no other devices")

        val row = bob.awaitRow { it.entryId == "dm_1" }
        assertEquals("directMessage", row.modelKey)
        assertEquals(1_700_000_000_000, row.sentAt)
        assertEquals(alice.userId, row.senderUserId)
        assertEquals(alice.deviceId, row.senderDeviceId)
        assertArrayEquals(payload, row.payload)
        assertEquals("directMessage", withTimeout(5_000) { bob.messageReceived.receive() })

        sendAndVerify(bob, alice, "reply")
        assertEquals(1L, bob.inbox.depth(), "the sender gets no copy of its own entry")
        assertEquals(emptyList<Any>(), alice.entries.all("directMessage"), "send stores nothing locally")
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `an unreachable recipient is rejected without stopping the others`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("partial_a")
        val bob = registerAndConnect("partial_b")
        becomeFriends(alice, bob)
        val ghost = java.util.UUID.randomUUID().toString()

        val report = alice.send(listOf(ghost, bob.userId!!), "story", "s1", System.currentTimeMillis(),
            """{"content":"reaches bob anyway"}""".toByteArray())

        assertEquals(SubmissionStatus.REJECTED, report.recipients.single { it.userId == ghost }.status)
        assertEquals(SubmissionStatus.ACCEPTED, report.recipients.single { it.userId == bob.userId }.status)
        bob.awaitContent("reaches bob anyway")
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `a far-future timestamp is clamped before it is stored`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("clamp_a")
        val bob = registerAndConnect("clamp_b")
        becomeFriends(alice, bob)
        val before = System.currentTimeMillis()

        sendText(alice, bob, "from the far future", sentAt = Long.MAX_VALUE)

        val row = bob.awaitContent("from the far future")
        assertTrue(row.sentAt!! in 1..before + 120_000, "sentAt was ${row.sentAt}")
        alice.disconnect(); bob.disconnect()
    }

    @Test
    fun `messages sent while offline arrive on reconnect in order and drain with peek then consume`() = runBlocking {
        requireServer()
        val alice = registerAndConnect("offline_a")
        val bob = registerAndConnect("offline_b")
        becomeFriends(alice, bob)

        bob.disconnect()
        sendText(alice, bob, "one")
        sendText(alice, bob, "two")
        bob.connect()

        eventually { bob.inbox.depth() == 2L }
        val batch = bob.inbox.peek()
        assertEquals(listOf("one", "two"), batch.map { it.content() })
        assertEquals(batch, bob.inbox.peek(), "peek does not remove")
        bob.inbox.consume(listOf(batch[0].id))
        assertEquals(1L, bob.inbox.depth())
        bob.inbox.consume(batch.map { it.id })
        assertEquals(0L, bob.inbox.depth())
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
        alice.send(listOf(bob.userId!!), "story", "story_1", System.currentTimeMillis(),
            JSONObject(mapOf("content" to "vacation", "mediaRef" to attachment.id)).toString().toByteArray())

        val row = bob.awaitContent("vacation")
        assertEquals("story", row.modelKey)
        val mediaRef = JSONObject(String(row.payload)).getString("mediaRef")
        assertArrayEquals(jpeg, bob.downloadDecryptedAttachment(mediaRef, attachment.contentKey, attachment.nonce))
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
