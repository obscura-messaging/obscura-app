package scenarios

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import dev.barrelmaker.obscura.kit.crypto.SignalStore
import dev.barrelmaker.obscura.kit.db.ObscuraDatabase
import dev.barrelmaker.obscura.kit.generateIdentity
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.*
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.state.*

class SignalStoreTests {

    private lateinit var store: SignalStore
    private lateinit var db: ObscuraDatabase

    @BeforeEach
    fun setup() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ObscuraDatabase.Schema.create(driver)
        db = ObscuraDatabase(driver)
        db.deviceQueries.insert("alice-user", "alice-phone")
        db.deviceQueries.insert("alice-user", "alice-tablet")
        db.deviceQueries.insert("bob-user", "bob-phone")
        store = SignalStore(db)
    }

    @Test
    fun `an installed identity is used and survives a reload`() {
        val (keyPair, regId) = store.generateIdentity()
        assertTrue(regId > 0, "Registration ID should be positive")
        assertEquals(keyPair, store.getIdentityKeyPair())
        assertEquals(regId, store.getLocalRegistrationId())

        val reloaded = SignalStore(db)
        assertArrayEquals(keyPair.serialize(), reloaded.getIdentityKeyPair().serialize())
        assertEquals(regId, reloaded.getLocalRegistrationId())
    }

    @Test
    fun `the first identity of an account is trusted on first use`() {
        val remoteKey = IdentityKeyPair.generate()
        val change = store.saveIdentity(SignalProtocolAddress("alice-phone", 1), remoteKey.publicKey)
        assertEquals(IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED, change)
    }

    @Test
    fun `identity is per account, so every device of the user resolves to it`() {
        val key = IdentityKeyPair.generate()
        var changes = 0
        store.onIdentityChanged = { changes++ }

        store.saveIdentity(SignalProtocolAddress("alice-phone", 1), key.publicKey)
        assertEquals(IdentityKeyStore.IdentityChange.NEW_OR_UNCHANGED,
            store.saveIdentity(SignalProtocolAddress("alice-tablet", 1), key.publicKey))

        assertEquals(key.publicKey, store.getIdentity(SignalProtocolAddress("alice-tablet", 1)))
        assertNull(store.getIdentity(SignalProtocolAddress("bob-phone", 1)))
        assertEquals(0, changes)
    }

    @Test
    fun `a changed account identity is trusted, saved, reported by user and drops all of the user's sessions`() {
        val key1 = IdentityKeyPair.generate()
        val key2 = IdentityKeyPair.generate()
        val changes = mutableListOf<String>()
        store.onIdentityChanged = { changes += it }
        store.saveIdentity(SignalProtocolAddress("alice-phone", 1), key1.publicKey)
        for (device in listOf("alice-phone", "alice-tablet", "bob-phone")) store.storeSession(SignalProtocolAddress(device, 1), SessionRecord())

        assertTrue(store.isTrustedIdentity(SignalProtocolAddress("alice-tablet", 1), key2.publicKey, IdentityKeyStore.Direction.SENDING))
        assertTrue(store.isTrustedIdentity(SignalProtocolAddress("alice-tablet", 1), key2.publicKey, IdentityKeyStore.Direction.RECEIVING))
        assertEquals(IdentityKeyStore.IdentityChange.REPLACED_EXISTING,
            store.saveIdentity(SignalProtocolAddress("alice-tablet", 1), key2.publicKey))

        assertEquals(key2.publicKey, store.getIdentity(SignalProtocolAddress("alice-tablet", 1)))
        assertNull(store.getIdentity(SignalProtocolAddress("alice-phone", 1)))
        assertEquals(listOf("alice-user"), changes)
        assertFalse(store.containsSession(SignalProtocolAddress("alice-phone", 1)))
        assertFalse(store.containsSession(SignalProtocolAddress("alice-tablet", 1)))
        assertTrue(store.containsSession(SignalProtocolAddress("bob-phone", 1)))
    }

    @Test
    fun `a device outside the directory has no identity and cannot save one`() {
        assertNull(store.getIdentity(SignalProtocolAddress("stranger", 1)))
        assertThrows(IllegalStateException::class.java) {
            store.saveIdentity(SignalProtocolAddress("stranger", 1), IdentityKeyPair.generate().publicKey)
        }
    }

    @Test
    fun `Prekey store-load round trip`() {
        store.generateIdentity()
        val keyPair = Curve.generateKeyPair()
        val record = PreKeyRecord(1, keyPair)
        store.storePreKey(1, record)

        val loaded = store.loadPreKey(1)
        assertEquals(1, loaded.id)
        assertTrue(store.containsPreKey(1))
    }

    @Test
    fun `Prekey removal works`() {
        store.generateIdentity()
        val keyPair = Curve.generateKeyPair()
        store.storePreKey(42, PreKeyRecord(42, keyPair))
        assertTrue(store.containsPreKey(42))

        store.removePreKey(42)
        assertFalse(store.containsPreKey(42))
    }

    @Test
    fun `Missing prekey throws InvalidKeyIdException`() {
        store.generateIdentity()
        assertThrows(InvalidKeyIdException::class.java) {
            store.loadPreKey(999)
        }
    }

    @Test
    fun `Prekey count tracks additions and removals`() {
        store.generateIdentity()
        assertEquals(0L, store.getPreKeyCount())

        for (i in 1..10) {
            store.storePreKey(i, PreKeyRecord(i, Curve.generateKeyPair()))
        }
        assertEquals(10L, store.getPreKeyCount())

        store.removePreKey(1)
        store.removePreKey(2)
        assertEquals(8L, store.getPreKeyCount())
    }

    @Test
    fun `Highest prekey ID tracks correctly`() {
        store.generateIdentity()
        store.storePreKey(5, PreKeyRecord(5, Curve.generateKeyPair()))
        store.storePreKey(50, PreKeyRecord(50, Curve.generateKeyPair()))
        store.storePreKey(25, PreKeyRecord(25, Curve.generateKeyPair()))

        assertEquals(50L, store.getHighestPreKeyId())
    }

    @Test
    fun `Signed prekey store-load round trip`() {
        val (identity, _) = store.generateIdentity()
        val keyPair = Curve.generateKeyPair()
        val signature = Curve.calculateSignature(identity.privateKey, keyPair.publicKey.serialize())
        val record = SignedPreKeyRecord(1, System.currentTimeMillis(), keyPair, signature)
        store.storeSignedPreKey(1, record)

        val loaded = store.loadSignedPreKey(1)
        assertEquals(1, loaded.id)
        assertTrue(store.containsSignedPreKey(1))
    }

    @Test
    fun `Missing signed prekey throws InvalidKeyIdException`() {
        store.generateIdentity()
        assertThrows(InvalidKeyIdException::class.java) {
            store.loadSignedPreKey(999)
        }
    }

    @Test
    fun `Session store-load round trip`() {
        store.generateIdentity()
        val address = SignalProtocolAddress("bob", 1)
        val record = SessionRecord()
        store.storeSession(address, record)

        assertTrue(store.containsSession(address))
        val loaded = store.loadSession(address)
        assertNotNull(loaded)
    }

    @Test
    fun `Missing session returns empty SessionRecord (not exception)`() {
        store.generateIdentity()
        val address = SignalProtocolAddress("nobody", 1)
        assertFalse(store.containsSession(address))
        val loaded = store.loadSession(address)
        assertNotNull(loaded)
    }

    @Test
    fun `Delete session removes it`() {
        store.generateIdentity()
        val address = SignalProtocolAddress("bob", 1)
        store.storeSession(address, SessionRecord())
        assertTrue(store.containsSession(address))

        store.deleteSession(address)
        assertFalse(store.containsSession(address))
    }

    @Test
    fun `deleteAllSessions removes all sessions for a user`() {
        store.generateIdentity()
        store.storeSession(SignalProtocolAddress("bob", 1), SessionRecord())
        store.storeSession(SignalProtocolAddress("bob", 2), SessionRecord())
        store.storeSession(SignalProtocolAddress("bob", 3), SessionRecord())
        store.storeSession(SignalProtocolAddress("alice", 1), SessionRecord())

        store.deleteAllSessions("bob")

        assertFalse(store.containsSession(SignalProtocolAddress("bob", 1)))
        assertFalse(store.containsSession(SignalProtocolAddress("bob", 2)))
        assertFalse(store.containsSession(SignalProtocolAddress("bob", 3)))
        assertTrue(store.containsSession(SignalProtocolAddress("alice", 1)),
            "Alice's session should be untouched")
    }

}
