package dev.barrelmaker.obscura.kit.managers

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.crypto.toBase64
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.generateIdentity
import dev.barrelmaker.obscura.kit.managers.SignalKeyUtils.toApiJson
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.state.PreKeyBundle

class SignalKeyUtilsTest {

    private lateinit var store: SignalStore
    private lateinit var db: ObscuraDatabase

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        db = ObscuraDatabase(driver)
        store = SignalStore(db)
    }

    private fun provisioned(): ProvisioningKeys =
        SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate()).also { SignalKeyUtils.install(store, it) }

    @Test
    fun `a signed prekey's signature verifies against the identity key`() {
        val identity = IdentityKeyPair.generate()
        val record = SignalKeyUtils.signedPreKey(identity, id = 7)

        assertEquals(7, record.id)
        assertTrue(Curve.verifySignature(identity.publicKey.publicKey, record.keyPair.publicKey.serialize(), record.signature))
    }

    @Test
    fun `provisioning keys are signed by the given identity and stored only on install`() {
        val identity = IdentityKeyPair.generate()
        val keys = SignalKeyUtils.generateProvisioningKeys(identity)

        assertEquals(SignalKeyUtils.SIGNED_PREKEY_ID, keys.signedPreKey.id)
        assertTrue(identity.publicKey.publicKey.verifySignature(keys.signedPreKey.keyPair.publicKey.serialize(), keys.signedPreKey.signature))
        assertEquals((1..100).toList(), keys.oneTimePreKeys.map { it.id })
        assertTrue(keys.registrationId > 0)
        assertFalse(store.hasIdentity())
        assertEquals(0L, store.getPreKeyCount())

        SignalKeyUtils.install(store, keys)

        assertArrayEquals(identity.serialize(), store.identityKeyPair.serialize())
        assertEquals(keys.registrationId, store.localRegistrationId)
        assertEquals(100L, store.getPreKeyCount())
        assertArrayEquals(keys.signedPreKey.serialize(), store.loadSignedPreKey(1).serialize())
        assertArrayEquals(identity.serialize(), SignalStore(db).identityKeyPair.serialize())
    }

    @Test
    fun `an install inside a rolled-back transaction leaves no identity`() {
        val keys = SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate())
        runCatching { db.transaction { SignalKeyUtils.install(store, keys); error("server refused") } }

        assertFalse(store.hasIdentity())
        assertEquals(0L, store.getPreKeyCount())
    }

    @Test
    fun `device keys carry the identity, registration id and prekeys the server expects`() {
        val keys = SignalKeyUtils.generateProvisioningKeys(IdentityKeyPair.generate())
        val json = keys.toDeviceKeys().toJson()

        assertEquals(setOf("identityKey", "registrationId", "signedPreKey", "oneTimePreKeys"), json.keySet())
        assertEquals(keys.identity.publicKey.serialize().toBase64(), json.getString("identityKey"))
        assertEquals(keys.registrationId, json.getInt("registrationId"))
        assertEquals(keys.signedPreKey.toApiJson().signature, json.getJSONObject("signedPreKey").getString("signature"))
        assertEquals(100, json.getJSONArray("oneTimePreKeys").length())
    }

    @Test
    fun `every refill advances the signed prekey id required by the server across reloads`() {
        val initial = provisioned()
        var serverMaxId = initial.signedPreKey.id
        val records = mutableMapOf(serverMaxId to store.loadSignedPreKey(serverMaxId).serialize())

        repeat(3) { refill ->
            store = SignalStore(db)
            val upload = SignalKeyUtils.generateMorePreKeys(store, 50)

            assertEquals(setOf("signedPreKey", "oneTimePreKeys"), upload.toJson().keySet(), "a refill cannot carry the identity")
            assertEquals(serverMaxId + 1, upload.signedPreKey.keyId)
            assertEquals((101 + refill * 50..150 + refill * 50).toList(), upload.oneTimePreKeys.map { it.keyId })
            val signed = store.loadSignedPreKey(upload.signedPreKey.keyId)
            assertEquals(signed.toApiJson(), upload.signedPreKey)
            assertTrue(Curve.verifySignature(initial.identity.publicKey.publicKey, signed.keyPair.publicKey.serialize(), signed.signature))
            records.forEach { (id, bytes) -> assertArrayEquals(bytes, store.loadSignedPreKey(id).serialize()) }
            serverMaxId = upload.signedPreKey.keyId
            records[serverMaxId] = signed.serialize()
        }
    }

    @Test
    fun `a refill after an unpublished attempt does not reuse its signed prekey id`() {
        provisioned()
        val unpublished = SignalKeyUtils.generateMorePreKeys(store, 50)
        store = SignalStore(db)

        val retry = SignalKeyUtils.generateMorePreKeys(store, 50)

        assertEquals(3, retry.signedPreKey.keyId)
        assertEquals((151..200).toList(), retry.oneTimePreKeys.map { it.keyId })
        assertTrue(store.containsSignedPreKey(unpublished.signedPreKey.keyId))
    }

    @Test
    fun `a message using an earlier bundle still decrypts after signed prekey rotation`() {
        provisioned()
        val signed = store.loadSignedPreKey(1)
        val preKey = store.loadPreKey(1)
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            ObscuraDatabase.Schema.create(driver)
            val senderDb = ObscuraDatabase(driver)
            senderDb.deviceQueries.insert("receiver-user", "receiver")
            val sender = SignalStore(senderDb).also { it.generateIdentity() }
            val receiverAddress = SignalProtocolAddress("receiver", 1)
            SessionBuilder(sender, receiverAddress).process(PreKeyBundle(
                store.localRegistrationId, 1, preKey.id, preKey.keyPair.publicKey,
                signed.id, signed.keyPair.publicKey, signed.signature, store.identityKeyPair.publicKey,
            ))
            val plaintext = "delayed message".toByteArray()
            val ciphertext = SessionCipher(sender, receiverAddress).encrypt(plaintext)

            repeat(2) { SignalKeyUtils.generateMorePreKeys(store, 50) }
            store = SignalStore(db)
            db.deviceQueries.insert("sender-user", "sender")

            assertArrayEquals(plaintext, SessionCipher(store, SignalProtocolAddress("sender", 1))
                .decrypt(PreKeySignalMessage(ciphertext.serialize())))
        }
    }

    @Test
    fun `older signed prekeys stay for the grace period after a newer one is published`() {
        val grace = SignalStore.SIGNED_PREKEY_GRACE_MS
        provisioned()
        val second = SignalKeyUtils.generateMorePreKeys(store, 50).signedPreKey.keyId
        store.retireSignedPreKeys(second, nowMs = 0)

        store.retireSignedPreKeys(second, nowMs = grace - 1)
        assertTrue(store.containsSignedPreKey(1))

        store.retireSignedPreKeys(second, nowMs = grace)
        assertFalse(store.containsSignedPreKey(1))
        assertTrue(store.containsSignedPreKey(second))
    }

    @Test
    fun `the grace period runs from the first publish that superseded a key`() {
        val grace = SignalStore.SIGNED_PREKEY_GRACE_MS
        provisioned()
        val second = SignalKeyUtils.generateMorePreKeys(store, 50).signedPreKey.keyId
        store.retireSignedPreKeys(second, nowMs = 0)
        val unpublished = SignalKeyUtils.generateMorePreKeys(store, 50).signedPreKey.keyId
        val third = SignalKeyUtils.generateMorePreKeys(store, 50).signedPreKey.keyId

        store.retireSignedPreKeys(third, nowMs = grace)

        assertFalse(store.containsSignedPreKey(1))
        assertTrue(store.containsSignedPreKey(second))
        assertTrue(store.containsSignedPreKey(unpublished))
        assertTrue(store.containsSignedPreKey(third))
    }
}
