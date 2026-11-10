package dev.barrelmaker.obscura.kit.managers

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.bundle
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.generateIdentity
import dev.barrelmaker.obscura.kit.messaging.parsePeerBundle
import dev.barrelmaker.obscura.kit.network.PreKeyCounts
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.util.Medium

class PreKeysTest {

    private lateinit var store: SignalStore
    private lateinit var db: ObscuraDatabase

    private val day = 24L * 60 * 60 * 1000
    private val plenty = PreKeyCounts(PreKeys.BATCH_SIZE, PreKeys.BATCH_SIZE)

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        db = ObscuraDatabase(driver)
        store = SignalStore(db)
    }

    private fun provisioned(nowMs: Long = 0): ProvisioningKeys =
        PreKeys.generateProvisioningKeys(IdentityKeyPair.generate(), nowMs).also { PreKeys.install(store, it) }

    private fun state() = store.preKeyState()!!

    @Test
    fun `provisioning signs every published key with the identity`() {
        val keys = PreKeys.generateProvisioningKeys(IdentityKeyPair.generate())
        val identity = keys.identity.publicKey.publicKey

        assertTrue(identity.verifySignature(keys.signedPreKey.keyPair.publicKey.serialize(), keys.signedPreKey.signature))
        assertTrue(identity.verifySignature(keys.lastResortKyberPreKey.keyPair.publicKey.serialize(), keys.lastResortKyberPreKey.signature))
        keys.kyberPreKeys.forEach { assertTrue(identity.verifySignature(it.keyPair.publicKey.serialize(), it.signature)) }
        assertEquals(PreKeys.BATCH_SIZE, keys.oneTimePreKeys.size)
        assertEquals(PreKeys.BATCH_SIZE, keys.kyberPreKeys.size)
        assertTrue(keys.registrationId in 1..0x3FFF, "the server accepts 1 through 16383")
    }

    @Test
    fun `ids start at random points, and Kyber one-time ids follow the last-resort id on one counter`() {
        val a = PreKeys.generateProvisioningKeys(IdentityKeyPair.generate())
        val b = PreKeys.generateProvisioningKeys(IdentityKeyPair.generate())
        assertNotEquals(
            listOf(a.signedPreKey.id, a.oneTimePreKeys.first().id, a.lastResortKyberPreKey.id),
            listOf(b.signedPreKey.id, b.oneTimePreKeys.first().id, b.lastResortKyberPreKey.id),
        )

        val lastResort = a.lastResortKyberPreKey.id
        val expected = (1..PreKeys.BATCH_SIZE).map { (lastResort + it) % Medium.MAX_VALUE }
        assertEquals(expected, a.kyberPreKeys.map { it.id })
        assertEquals(((expected.last() + 1) % Medium.MAX_VALUE).toLong(), a.state.next_kyber_id)
        assertEquals(a.signedPreKey.id.toLong(), a.state.active_signed_id)
        assertEquals(lastResort.toLong(), a.state.active_last_resort_id)
    }

    @Test
    fun `installing stores every key and its bookkeeping`() {
        val keys = provisioned()

        assertTrue(store.containsSignedPreKey(keys.signedPreKey.id))
        assertTrue(store.containsKyberPreKey(keys.lastResortKyberPreKey.id))
        assertEquals(listOf(keys.lastResortKyberPreKey.id), store.loadLastResortKyberPreKeys().map { it.id })
        assertEquals(PreKeys.BATCH_SIZE + 1, store.loadKyberPreKeys().size)
        keys.oneTimePreKeys.forEach { assertTrue(store.containsPreKey(it.id)) }
        assertEquals(keys.state, state())
    }

    @Test
    fun `nothing is uploaded while the server has enough keys and nothing is due`() {
        provisioned(nowMs = 0)

        val refill = PreKeys.prepareRefill(store, plenty, nowMs = day)

        assertTrue(refill.isEmpty)
        assertEquals(emptySet<String>(), refill.toUpload().toJson().keySet())
    }

    @Test
    fun `a kind the server holds fewer than 10 of is refilled with a new batch`() {
        val keys = provisioned()
        val nextOneTime = state().next_one_time_id.toInt()

        val refill = PreKeys.prepareRefill(store, PreKeyCounts(oneTime = 9, kyber = 10), nowMs = day)

        assertEquals((0 until PreKeys.BATCH_SIZE).map { nextOneTime + it }, refill.oneTimePreKeys.map { it.id })
        assertEquals(emptyList<Int>(), refill.kyberPreKeys.map { it.id })
        assertNull(refill.signedPreKey)
        assertNull(refill.lastResortKyberPreKey)
        refill.oneTimePreKeys.forEach { assertTrue(store.containsPreKey(it.id)) }
        assertTrue(store.containsPreKey(keys.oneTimePreKeys.first().id), "replaced keys stay for messages in flight")
        assertEquals((nextOneTime + PreKeys.BATCH_SIZE).toLong(), state().next_one_time_id)
    }

    @Test
    fun `a Kyber refill continues the counter the last-resort key shares`() {
        provisioned()
        val nextKyber = state().next_kyber_id.toInt()

        val refill = PreKeys.prepareRefill(store, PreKeyCounts(oneTime = 10, kyber = 0), nowMs = day)

        assertEquals((0 until PreKeys.BATCH_SIZE).map { nextKyber + it }, refill.kyberPreKeys.map { it.id })
        refill.kyberPreKeys.forEach { assertTrue(store.containsKyberPreKey(it.id)) }
        assertEquals(1, store.loadLastResortKyberPreKeys().size)
    }

    @Test
    fun `ids wrap at Medium MAX_VALUE`() {
        provisioned()
        store.savePreKeyState(state().copy(next_one_time_id = Medium.MAX_VALUE - 2L))

        val ids = PreKeys.prepareRefill(store, PreKeyCounts(0, PreKeys.BATCH_SIZE), nowMs = day).oneTimePreKeys.map { it.id }

        assertEquals(listOf(Medium.MAX_VALUE - 2, Medium.MAX_VALUE - 1, 0, 1), ids.take(4))
        assertEquals(PreKeys.BATCH_SIZE - 2L, state().next_one_time_id)
    }

    @Test
    fun `the signed and last-resort keys rotate every 2 days and become active once uploaded`() {
        val keys = provisioned(nowMs = 0)
        assertNull(PreKeys.prepareRefill(store, plenty, nowMs = PreKeys.REFRESH_INTERVAL_MS - 1).signedPreKey)

        val refill = PreKeys.prepareRefill(store, plenty, nowMs = PreKeys.REFRESH_INTERVAL_MS)
        val signed = refill.signedPreKey!!
        val lastResort = refill.lastResortKyberPreKey!!
        assertTrue(keys.identity.publicKey.publicKey.verifySignature(signed.keyPair.publicKey.serialize(), signed.signature))
        assertEquals(keys.signedPreKey.id.toLong(), state().active_signed_id, "not active until the server accepts it")
        assertEquals(setOf("signedPreKey", "lastResortKyberPreKey"), refill.toUpload().toJson().keySet())

        PreKeys.confirmRefill(store, refill, nowMs = PreKeys.REFRESH_INTERVAL_MS)

        assertEquals(signed.id.toLong(), state().active_signed_id)
        assertEquals(lastResort.id.toLong(), state().active_last_resort_id)
        assertEquals(PreKeys.REFRESH_INTERVAL_MS, state().signed_rotated_at)
        assertTrue(store.containsSignedPreKey(keys.signedPreKey.id), "the previous key stays for messages in flight")
    }

    @Test
    fun `a clock set back rotates rather than waiting for it to catch up`() {
        provisioned(nowMs = 10 * day)

        val refill = PreKeys.prepareRefill(store, plenty, nowMs = day)

        assertTrue(refill.signedPreKey != null && refill.lastResortKyberPreKey != null)
    }

    @Test
    fun `a sync is due once the last one is 2 days old, and never before provisioning`() {
        assertFalse(PreKeys.isSyncDue(store, nowMs = 0))
        provisioned(nowMs = 0)
        assertFalse(PreKeys.isSyncDue(store, nowMs = PreKeys.REFRESH_INTERVAL_MS - 1))
        assertTrue(PreKeys.isSyncDue(store, nowMs = PreKeys.REFRESH_INTERVAL_MS))

        PreKeys.confirmRefill(store, PreKeys.prepareRefill(store, plenty, nowMs = PreKeys.REFRESH_INTERVAL_MS), PreKeys.REFRESH_INTERVAL_MS)
        assertFalse(PreKeys.isSyncDue(store, nowMs = PreKeys.REFRESH_INTERVAL_MS + 1))
    }

    @Test
    fun `replaced signed keys older than 30 days go, except the youngest of them`() {
        val keys = provisioned(nowMs = 0)
        val rotations = (1..3).map { n ->
            val now = n * 10 * day
            PreKeys.prepareRefill(store, plenty, now).also { PreKeys.confirmRefill(store, it, now) }.signedPreKey!!.id
        }
        // At day 30: the original key (day 0) and the first rotation (day 10) are not older than 30 days yet.
        assertTrue(store.containsSignedPreKey(keys.signedPreKey.id))

        store.cleanPreKeys(45 * day)

        assertFalse(store.containsSignedPreKey(keys.signedPreKey.id), "older than 30 days, and not the youngest such")
        assertTrue(store.containsSignedPreKey(rotations[0]), "the youngest key older than 30 days stays")
        assertTrue(store.containsSignedPreKey(rotations[1]))
        assertTrue(store.containsSignedPreKey(rotations[2]), "the active key always stays")
        assertFalse(store.containsKyberPreKey(keys.lastResortKyberPreKey.id), "last-resort keys are cleaned the same way")
    }

    @Test
    fun `stale one-time keys go after 90 days, keeping at least 200`() {
        val keys = provisioned(nowMs = 0)
        repeat(3) { PreKeys.prepareRefill(store, PreKeyCounts(0, 0), nowMs = day) }
        // 400 EC keys: the provisioned batch and two refills are stale since day 1, the last batch is fresh.

        store.cleanPreKeys(day + 90 * day - 1)
        assertTrue(store.containsPreKey(keys.oneTimePreKeys.first().id), "not yet stale for 90 days")

        store.cleanPreKeys(2 * day + 90 * day)
        assertEquals(200L, db.signalKeyQueries.countPreKeys().executeAsOne())
        assertEquals(200L + 1, store.loadKyberPreKeys().size.toLong(), "200 one-time Kyber keys and the last-resort key")
        assertFalse(store.containsPreKey(keys.oneTimePreKeys.first().id))
    }

    @Test
    fun `a session started from a bundle decrypts with PQXDH and uses up both one-time keys`() {
        val keys = provisioned()
        val senderId = java.util.UUID.randomUUID().toString()
        val receiverId = java.util.UUID.randomUUID().toString()
        db.deviceQueries.insert("sender-user", senderId)
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            ObscuraDatabase.Schema.create(driver)
            val senderDb = ObscuraDatabase(driver).apply { deviceQueries.insert("receiver-user", receiverId) }
            val sender = SignalStore(senderDb).also { it.generateIdentity() }
            val senderAddress = SignalProtocolAddress(senderId, 1)
            val receiverAddress = SignalProtocolAddress(receiverId, 1)
            SessionBuilder(sender, receiverAddress, senderAddress).process(parsePeerBundle(keys.bundle(receiverId)).bundle)
            val plaintext = "hello".toByteArray()
            val ciphertext = SessionCipher(sender, senderAddress, receiverAddress).encrypt(plaintext)

            // Rotation before the message arrives must not strand it.
            PreKeys.confirmRefill(store, PreKeys.prepareRefill(store, PreKeyCounts(0, 0), PreKeys.REFRESH_INTERVAL_MS), PreKeys.REFRESH_INTERVAL_MS)

            val message = PreKeySignalMessage(ciphertext.serialize())
            assertArrayEquals(plaintext, SessionCipher(store, receiverAddress, senderAddress).decrypt(message))
            assertFalse(store.containsPreKey(keys.oneTimePreKeys.first().id))
            assertFalse(store.containsKyberPreKey(keys.kyberPreKeys.first().id))
            assertTrue(store.containsKyberPreKey(keys.lastResortKyberPreKey.id))
        }
    }
}
