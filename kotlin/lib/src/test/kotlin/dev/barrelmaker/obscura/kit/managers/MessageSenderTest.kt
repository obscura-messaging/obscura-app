package dev.barrelmaker.obscura.kit.managers

import dev.barrelmaker.obscura.kit.SubmissionResult
import dev.barrelmaker.obscura.kit.SubmissionStatus.ACCEPTED
import dev.barrelmaker.obscura.kit.SubmissionStatus.REJECTED
import dev.barrelmaker.obscura.kit.crypto.UuidCodec
import dev.barrelmaker.obscura.kit.messaging.Messenger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import obscura.client.v1.Client.ClientMessage
import obscura.client.v1.Client.EncryptedMessage.Type.TYPE_ENCRYPTED_MESSAGE
import obscura.client.v1.Client.EncryptedMessage.Type.TYPE_PREKEY_MESSAGE
import obscura.client.v1.appEntry
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.IdentityKeyPair
import java.util.UUID

/**
 * The send path against real Signal peers on an in-process server with complete delivery. Every
 * bundle fetch consumes a one-time prekey on the fetched device, so the counts here are the cost.
 */
class MessageSenderTest {
    private val server = FakeObscuraServer()
    private val alice = server.register(user())
    private val bob = server.register(user())

    @AfterEach fun close() = server.close()

    private fun user() = UUID.randomUUID().toString()

    private fun entry(id: String): ClientMessage = ClientMessage.newBuilder()
        .setAppEntry(appEntry { model = "m"; this.id = id }).build()

    private suspend fun FakeDevice.send(to: FakeDevice, id: String) =
        sender.send(to.userId, entry(id))

    private fun accepted(device: FakeDevice) = SubmissionResult(device.userId, device.deviceId, ACCEPTED)

    private fun targetsOf(request: Int) = server.requests[request].second.recipientsList
        .flatMap { it.submissionsList }
        .map { UuidCodec.uuidString(it.deviceId) }
        .toSet()

    @Test
    fun `a first contact fetches the user whole once and later sends reuse the session`() = runBlocking {
        repeat(3) { assertEquals(listOf(accepted(bob)), alice.send(bob, "e$it")) }

        val received = bob.receive()
        assertEquals(listOf("e0", "e1", "e2"), received.map { it.message.appEntry.id })
        // Unacknowledged sessions keep sending prekey messages, all from the one session.
        assertEquals(1, received.map { it.baseKey }.distinct().size)
        assertEquals(1, server.prekeysConsumed(bob.userId))
        assertEquals(99, bob.remainingPreKeys)
        assertEquals(listOf(bob.deviceId), alice.directory.devicesOf(bob.userId))
    }

    @Test
    fun `a session learned from an incoming message is used without a fetch`() = runBlocking {
        alice.send(bob, "hello")
        bob.receive()

        assertEquals(listOf(accepted(alice)), bob.send(alice, "reply"))
        assertEquals(0, server.prekeysConsumed(alice.userId))
        assertEquals(listOf(TYPE_ENCRYPTED_MESSAGE), alice.receive().map { it.type })

        alice.send(bob, "after-reply")
        assertEquals(listOf(TYPE_ENCRYPTED_MESSAGE), bob.receive().map { it.type })
        assertEquals(1, server.prekeysConsumed(bob.userId))
    }

    @Test
    fun `a device linked mid-conversation is found through the mismatch and fetched alone`() = runBlocking {
        alice.send(bob, "first")
        val firstKey = bob.receive().single().baseKey
        val bobTablet = server.register(bob.userId)

        assertEquals(setOf(accepted(bob), accepted(bobTablet)), alice.send(bob, "second").toSet())

        assertEquals(firstKey, bob.receive().single().baseKey)
        assertEquals(TYPE_PREKEY_MESSAGE, bobTablet.receive().single().type)
        assertEquals(99, bob.remainingPreKeys)
        assertEquals(99, bobTablet.remainingPreKeys)
        assertEquals(setOf(bob.deviceId, bobTablet.deviceId), alice.directory.devicesOf(bob.userId).toSet())
        assertEquals(setOf(bob.deviceId), targetsOf(1))
        assertEquals(setOf(bob.deviceId, bobTablet.deviceId), targetsOf(2))
        assertTrue(server.requests[1].first != server.requests[2].first, "a retry needs a new idempotency key")
    }

    @Test
    fun `an invalid device is removed while a mismatch adds its replacement`() = runBlocking {
        val bobTablet = server.register(bob.userId)
        alice.send(bob, "first")
        server.remove(bobTablet)
        val bobLaptop = server.register(bob.userId)

        assertEquals(setOf(accepted(bob), accepted(bobLaptop)), alice.send(bob, "second").toSet())
        assertEquals(setOf(bob.deviceId, bobLaptop.deviceId), alice.directory.devicesOf(bob.userId).toSet())
        assertEquals("second", bobLaptop.receive().single().message.appEntry.id)
    }

    @Test
    fun `a peer whose every device was replaced is reached in the same send`() = runBlocking {
        alice.send(bob, "first")
        server.remove(bob)
        val bobNew = server.register(bob.userId)

        assertEquals(listOf(accepted(bobNew)), alice.send(bob, "found"))
        assertEquals("found", bobNew.receive().single().message.appEntry.id)
        assertEquals(listOf(bobNew.deviceId), alice.directory.devicesOf(bob.userId))
    }

    @Test
    fun `every request names its recipient user`() = runBlocking {
        alice.directory.replace(alice.userId, listOf(alice.deviceId))
        alice.send(bob, "first")
        alice.send(alice, "note")

        assertEquals(listOf(listOf(bob.userId), listOf(alice.userId)),
            server.requests.map { (_, request) -> request.recipientsList.map { UuidCodec.uuidString(it.userId) } })
    }

    @Test
    fun `a mismatch that persists for three rounds is reported rejected with the mismatch`() = runBlocking {
        alice.send(bob, "first")
        val hidden = server.register(bob.userId, servesBundles = false)

        val result = alice.send(bob, "never").single()

        assertEquals(REJECTED, result.status)
        assertEquals(bob.deviceId, result.deviceId)
        assertTrue(result.error!!.contains(hidden.deviceId), result.error)
        assertEquals(4, server.requests.size)
        assertEquals(emptyList<Received>(), bob.receive().drop(1))
    }

    @Test
    fun `self sync on a lone device sends one request with no submission and fetches nothing`() = runBlocking {
        alice.directory.replace(alice.userId, listOf(alice.deviceId))

        assertEquals(emptyList<SubmissionResult>(), alice.send(alice, "note"))
        assertEquals(0, server.prekeysConsumed(alice.userId))
        assertEquals(0, server.requests.single().second.recipientsList.single().submissionsCount)
    }

    @Test
    fun `a device linked after this one is reached on the next self sync without any device listing`() = runBlocking {
        alice.directory.replace(alice.userId, listOf(alice.deviceId))
        val alicePhone = server.register(alice.userId)

        assertEquals(listOf(accepted(alicePhone)), alice.send(alice, "note"))
        assertEquals("note", alicePhone.receive().single().message.appEntry.id)
        assertEquals(setOf(alice.deviceId, alicePhone.deviceId), alice.directory.devicesOf(alice.userId).toSet())
    }

    @Test
    fun `self sync reaches the user's other devices and excludes this one from a whole fetch`() = runBlocking {
        val alicePhone = server.register(alice.userId)

        assertEquals(listOf(accepted(alicePhone)), alice.send(alice, "note"))
        assertEquals("note", alicePhone.receive().single().message.appEntry.id)
        assertEquals(emptyList<Received>(), alice.receive())
        assertEquals(listOf(alicePhone.deviceId), alice.directory.devicesOf(alice.userId))
    }

    @Test
    fun `concurrent first sends share one fetch`() = runBlocking {
        val results = (1..5).map { async { alice.send(bob, "c$it") } }.awaitAll()

        assertTrue(results.all { it == listOf(accepted(bob)) })
        assertEquals(1, server.prekeysConsumed(bob.userId))
        assertEquals(5, bob.receive().size)
    }

    @Test
    fun `a user with no devices is rejected`() = runBlocking {
        val ghost = user()
        val result = alice.sender.send(ghost, entry("lost")).single()

        assertEquals(ghost, result.userId)
        assertNull(result.deviceId)
        assertEquals(REJECTED, result.status)
        assertEquals(0, server.requests.size)
    }

    @Test
    fun `a peer with no devices left is one user-level rejection in the same send`() = runBlocking {
        alice.send(bob, "first")
        server.remove(bob)

        val result = alice.send(bob, "lost").single()

        assertEquals(REJECTED, result.status)
        assertNull(result.deviceId)
        assertEquals("No devices found", result.error)
        assertEquals(emptyList<String>(), alice.directory.devicesOf(bob.userId))
    }

    @Test
    fun `a bundle whose signed prekey does not verify rejects the user and stores nothing`() = runBlocking {
        val broken = server.register(bob.userId, corruptBundle = true)

        val result = alice.send(bob, "one").single()

        assertEquals(REJECTED, result.status)
        assertNull(result.deviceId)
        assertEquals(emptyList<String>(), alice.directory.devicesOf(bob.userId))
        assertFalse(alice.messenger.hasSession(bob.deviceId))
        assertFalse(alice.messenger.hasSession(broken.deviceId))
        assertNull(alice.signalStore.getIdentity(Messenger.addressFor(bob.deviceId)))
        assertEquals(0, server.requests.size)
    }

    @Test
    fun `bundles of one user that carry different identities reject the user and store nothing`() = runBlocking {
        server.register(bob.userId, identity = IdentityKeyPair.generate())

        val result = alice.send(bob, "one").single()

        assertEquals(REJECTED, result.status)
        assertTrue(result.error!!.contains("identity"), result.error)
        assertEquals(emptyList<String>(), alice.directory.devicesOf(bob.userId))
        assertFalse(alice.messenger.hasSession(bob.deviceId))
    }

    @Test
    fun `an account reset is accepted as an identity change and reached with a fresh session`() = runBlocking {
        val changes = mutableListOf<String>()
        alice.signalStore.onIdentityChanged = { changes += it }
        alice.send(bob, "before")
        bob.receive()
        server.reset(bob.userId)
        val bobNew = server.register(bob.userId)

        assertEquals(listOf(accepted(bobNew)), alice.send(bob, "after"))

        assertEquals("after", bobNew.receive().single().message.appEntry.id)
        assertEquals(listOf(bob.userId), changes)
    }

    @Test
    fun `a new account identity in an incoming prekey message drops the user's old sessions`() = runBlocking {
        val changes = mutableListOf<String>()
        alice.signalStore.onIdentityChanged = { changes += it }
        alice.send(bob, "before")
        bob.receive()
        bob.send(alice, "ack")
        alice.receive()
        server.reset(bob.userId)
        val bobNew = server.register(bob.userId)

        bobNew.send(alice, "from-new-identity")
        assertEquals("from-new-identity", alice.receive().single().message.appEntry.id)
        assertEquals(listOf(bob.userId), changes)
        assertFalse(alice.messenger.hasSession(bob.deviceId))
        assertEquals(listOf(bobNew.deviceId), alice.directory.devicesOf(bob.userId))

        assertEquals(listOf(accepted(bobNew)), alice.send(bob, "to-new-identity"))
        assertEquals("to-new-identity", bobNew.receive().single().message.appEntry.id)
        assertEquals(listOf(bobNew.deviceId), alice.directory.devicesOf(bob.userId))
        assertEquals(1, server.prekeysConsumed(bob.userId))
    }

    @Test
    fun `a device linked to an account keeps the account identity, so peers see no change`() = runBlocking {
        val changes = mutableListOf<String>()
        alice.signalStore.onIdentityChanged = { changes += it }
        alice.send(bob, "first")
        val bobTablet = server.register(bob.userId)
        bobTablet.send(alice, "from-tablet")
        alice.receive()
        alice.send(bob, "second")

        assertEquals(emptyList<String>(), changes)
        assertEquals(listOf("first", "second"), bob.receive().map { it.message.appEntry.id })
    }

    @Test
    fun `a multi-user send batches recipients into one request and retries only a mismatched user`() = runBlocking {
        val carol = server.register(user())
        alice.send(bob, "warm-bob")
        alice.send(carol, "warm-carol")
        bob.receive(); carol.receive()
        val carolTablet = server.register(carol.userId)
        val before = server.requests.size

        val results = alice.sender.send(listOf(bob.userId, carol.userId), entry("batched"))

        assertEquals(setOf(accepted(bob), accepted(carol), accepted(carolTablet)), results.toSet())
        assertEquals(2, server.requests.size - before, "round 1 settles bob and discovers carolTablet; round 2 retries carol only")
        assertEquals(setOf(bob.deviceId, carol.deviceId), targetsOf(before))
        assertEquals(setOf(carol.deviceId, carolTablet.deviceId), targetsOf(before + 1))
        assertEquals(listOf("batched"), bob.receive().map { it.message.appEntry.id })
        assertEquals(listOf("batched"), carol.receive().map { it.message.appEntry.id })
        assertEquals(listOf("batched"), carolTablet.receive().map { it.message.appEntry.id })
    }
}
