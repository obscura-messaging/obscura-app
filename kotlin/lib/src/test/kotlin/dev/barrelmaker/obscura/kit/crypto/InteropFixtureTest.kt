package dev.barrelmaker.obscura.kit.crypto

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.SessionBuilder
import org.signal.libsignal.protocol.SessionCipher
import org.signal.libsignal.protocol.SignalProtocolAddress
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyPair
import org.signal.libsignal.protocol.kem.KEMKeyType
import org.signal.libsignal.protocol.message.CiphertextMessage
import org.signal.libsignal.protocol.message.PreKeySignalMessage
import org.signal.libsignal.protocol.state.KyberPreKeyRecord
import org.signal.libsignal.protocol.state.PreKeyBundle
import org.signal.libsignal.protocol.state.PreKeyRecord
import org.signal.libsignal.protocol.state.SignedPreKeyRecord
import org.signal.libsignal.protocol.state.impl.InMemorySignalProtocolStore
import org.signal.libsignal.protocol.util.KeyHelper
import java.io.File

/**
 * Produces the Kotlin-to-Rust-core interop fixture: libsignal-client's wire format for a PQXDH
 * session as this kit uses it (Kyber-1024 prekeys signed by the identity key, as in [PreKeys]).
 * The round trip always runs; `OBSCURA_WRITE_FIXTURES=1` also writes the fixture to
 * `core/tests/fixtures/kotlin-to-core.json` for the Rust crate to decrypt without a JVM.
 */
class InteropFixtureTest {

    private val plaintexts = listOf("hello from kotlin 1", "hello from kotlin 2")

    @Test
    fun `a fixture from libsignal-client decrypts from its serialized records`() {
        val fixture = buildFixture()
        assertDecrypts(JSONObject(fixture))
        if (System.getenv("OBSCURA_WRITE_FIXTURES") == "1") {
            // Gradle runs tests from kotlin/lib; the fixture belongs under the repo root.
            val file = File("../../core/tests/fixtures/kotlin-to-core.json")
            file.parentFile.mkdirs()
            file.writeText(fixture)
        }
    }

    private fun buildFixture(): String {
        val bobIdentity = IdentityKeyPair.generate()
        val bobRegistrationId = 1234
        val bob = SignalProtocolAddress("bob", 1)
        val alice = SignalProtocolAddress("alice", 1)
        val signedPreKey = ECKeyPair.generate().let {
            SignedPreKeyRecord(1, 0, it, bobIdentity.privateKey.calculateSignature(it.publicKey.serialize()))
        }
        val kyberPreKey = KEMKeyPair.generate(KEMKeyType.KYBER_1024).let {
            KyberPreKeyRecord(2, 0, it, bobIdentity.privateKey.calculateSignature(it.publicKey.serialize()))
        }
        val preKey = PreKeyRecord(3, ECKeyPair.generate())

        val aliceStore = InMemorySignalProtocolStore(IdentityKeyPair.generate(), KeyHelper.generateRegistrationId(false))
        SessionBuilder(aliceStore, bob, alice).process(
            PreKeyBundle(
                bobRegistrationId, bob.deviceId,
                preKey.id, preKey.keyPair.publicKey,
                signedPreKey.id, signedPreKey.keyPair.publicKey, signedPreKey.signature,
                bobIdentity.publicKey,
                kyberPreKey.id, kyberPreKey.keyPair.publicKey, kyberPreKey.signature,
            ),
        )
        val cipher = SessionCipher(aliceStore, alice, bob)
        val messages = plaintexts.map { text ->
            val message = cipher.encrypt(text.toByteArray(Charsets.UTF_8))
            assertEquals(CiphertextMessage.PREKEY_TYPE, message.type, "no reply yet, so every message is a prekey message")
            """    { "kind": "prekey", "ciphertext": ${q(message.serialize().toBase64())}, "plaintext": ${q(text)} }"""
        }

        return """
            |{
            |  "libsignalVersion": "0.106.2",
            |  "recipient": {
            |    "name": ${q(bob.name)},
            |    "deviceId": ${bob.deviceId},
            |    "registrationId": $bobRegistrationId,
            |    "identityKeyPair": ${q(bobIdentity.serialize().toBase64())},
            |    "signedPreKeyRecord": ${q(signedPreKey.serialize().toBase64())},
            |    "kyberPreKeyRecord": ${q(kyberPreKey.serialize().toBase64())},
            |    "preKeyRecord": ${q(preKey.serialize().toBase64())}
            |  },
            |  "sender": {
            |    "name": ${q(alice.name)},
            |    "deviceId": ${alice.deviceId},
            |    "identityKey": ${q(aliceStore.identityKeyPair.publicKey.serialize().toBase64())}
            |  },
            |  "messages": [
            |${messages.joinToString(",\n")}
            |  ]
            |}
            |""".trimMargin()
    }

    /** Bob, rebuilt only from the fixture, decrypts both messages in order. */
    private fun assertDecrypts(fixture: JSONObject) {
        assertEquals("0.106.2", fixture.getString("libsignalVersion"))
        val r = fixture.getJSONObject("recipient")
        val s = fixture.getJSONObject("sender")
        val bobStore = InMemorySignalProtocolStore(IdentityKeyPair(r.getString("identityKeyPair").fromBase64()), r.getInt("registrationId"))
        SignedPreKeyRecord(r.getString("signedPreKeyRecord").fromBase64()).let { bobStore.storeSignedPreKey(it.id, it) }
        KyberPreKeyRecord(r.getString("kyberPreKeyRecord").fromBase64()).let { bobStore.storeKyberPreKey(it.id, it) }
        PreKeyRecord(r.getString("preKeyRecord").fromBase64()).let { bobStore.storePreKey(it.id, it) }

        val bob = SignalProtocolAddress(r.getString("name"), r.getInt("deviceId"))
        val alice = SignalProtocolAddress(s.getString("name"), s.getInt("deviceId"))
        val aliceIdentity = IdentityKey(s.getString("identityKey").fromBase64())
        val cipher = SessionCipher(bobStore, bob, alice)
        val messages = fixture.getJSONArray("messages")
        assertEquals(plaintexts.size, messages.length())
        for (i in 0 until messages.length()) {
            val m = messages.getJSONObject(i)
            assertEquals("prekey", m.getString("kind"))
            val message = PreKeySignalMessage(m.getString("ciphertext").fromBase64())
            assertEquals(aliceIdentity, message.identityKey)
            assertArrayEquals(m.getString("plaintext").toByteArray(Charsets.UTF_8), cipher.decrypt(message))
        }
        assertEquals(aliceIdentity, bobStore.getIdentity(alice))
    }

    private fun q(value: String) = JSONObject.quote(value)
}
