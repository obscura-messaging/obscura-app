package scenarios

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.crypto.LinkCrypto
import dev.barrelmaker.obscura.kit.stores.FriendData
import dev.barrelmaker.obscura.kit.stores.FriendStatus
import dev.barrelmaker.obscura.kit.wire.WireCodec
import obscura.client.v1.Client.HistorySnapshot
import obscura.client.v1.Client.LinkBundle
import obscura.client.v1.Client.LinkCode
import obscura.client.v1.Client.LinkEnvelope
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.IdentityKeyPair
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPrivateKey

/** `protocol/conformance/link.json`: every check its README lists. */
class LinkConformanceTest {
    private val vectors = loadVectors("link.json")

    @TestFactory
    fun `link envelopes`(): List<DynamicTest> = objects(vectors.getJSONArray("envelopes")).map { v ->
        DynamicTest.dynamicTest(v.getString("name")) { envelope(v) }
    }

    @TestFactory
    fun `link codes`(): List<DynamicTest> = objects(vectors.getJSONArray("linkCodes")).map { v ->
        DynamicTest.dynamicTest(v.getString("name")) { code(v) }
    }

    private fun envelope(v: JSONObject) {
        val newDevice = ECPrivateKey(v.getString("newDevicePrivateKey").hex())
        val primary = ECPrivateKey(v.getString("primaryPrivateKey").hex())
        assertEquals(v.getString("newDevicePublicKey"), newDevice.publicKey().serialize().hex(), "new device public key")
        assertEquals(v.getString("primaryPublicKey"), primary.publicKey().serialize().hex(), "primary public key")

        val newDevicePublic = Curve.decodePoint(v.getString("newDevicePublicKey").hex(), 0)
        val primaryPublic = Curve.decodePoint(v.getString("primaryPublicKey").hex(), 0)
        val shared = Curve.calculateAgreement(primaryPublic, newDevice)
        assertEquals(v.getString("sharedSecret"), shared.hex(), "shared secret from the new device")
        assertEquals(v.getString("sharedSecret"), Curve.calculateAgreement(newDevicePublic, primary).hex(), "shared secret from the primary")
        assertEquals(v.getString("key"), LinkCrypto.key(shared).hex(), "HKDF key")

        val plaintext = v.getString("plaintext").hex()
        val sealed = LinkCrypto.seal(plaintext, newDevicePublic, ECKeyPair(primaryPublic, primary), v.getString("nonce").hex())
        assertEquals(v.getString("ciphertext"), sealed.ciphertext.toByteArray().hex(), "sealed ciphertext")
        assertArrayEquals(plaintext, LinkCrypto.open(sealed.toByteArray(), newDevice), "open own envelope")
        assertArrayEquals(plaintext, LinkCrypto.open(v.getString("linkEnvelope").hex(), newDevice), "open vector envelope")

        val envelope = LinkEnvelope.parseFrom(v.getString("linkEnvelope").hex())
        assertEquals(v.getString("primaryPublicKey"), envelope.ephemeralPublicKey.toByteArray().hex())
        assertEquals(v.getString("nonce"), envelope.nonce.toByteArray().hex())
        assertEquals(v.getString("ciphertext"), envelope.ciphertext.toByteArray().hex())
        assertEquals(envelope, sealed, "own envelope by decoded value")

        val expected = v.getJSONObject("linkBundle")
        val bundle = LinkBundle.parseFrom(plaintext)
        assertEquals(expected.getString("identityKeyPair"), bundle.identityKeyPair.toByteArray().hex())
        assertEquals(expected.getString("userId"), bundle.userId)
        assertEquals(expected.getString("username"), bundle.username)
        assertEquals(expected.getString("primaryDeviceId"), bundle.primaryDeviceId)
        assertEquals(expected.getLong("friendListVersion"), bundle.friendListVersion)
        val friends = objects(expected.getJSONArray("friends")).map {
            FriendData(it.getString("userId"), it.getString("username"), status(it.getString("status")))
        }
        assertEquals(friends, bundle.friendsList.map { WireCodec.decodeFriend(it) })
        assertEquals(expected.has("history"), bundle.hasHistory())
        if (expected.has("history")) {
            val history = expected.getJSONObject("history")
            assertEquals(history.getString("attachmentId"), bundle.history.attachmentId)
            assertEquals(history.getString("contentKey"), bundle.history.contentKey.toByteArray().hex())
            assertEquals(history.getString("nonce"), bundle.history.nonce.toByteArray().hex())
        }

        val identity = IdentityKeyPair(expected.getString("identityKeyPair").hex())
        assertEquals(expected.getString("identityPrivateKey"), identity.privateKey.serialize().hex())
        assertEquals(expected.getString("identityPublicKey"), identity.publicKey.serialize().hex())
        val rebuilt = IdentityKeyPair(IdentityKey(expected.getString("identityPublicKey").hex()), ECPrivateKey(expected.getString("identityPrivateKey").hex()))
        assertEquals(expected.getString("identityKeyPair"), rebuilt.serialize().hex())

        val own = LinkBundle.newBuilder()
            .setIdentityKeyPair(ByteString.copyFrom(rebuilt.serialize()))
            .setUserId(expected.getString("userId"))
            .setUsername(expected.getString("username"))
            .setPrimaryDeviceId(expected.getString("primaryDeviceId"))
            .setFriendListVersion(expected.getLong("friendListVersion"))
            .addAllFriends(friends.map(WireCodec::encodeFriend))
        if (expected.has("history")) {
            val history = expected.getJSONObject("history")
            own.setHistory(HistorySnapshot.newBuilder()
                .setAttachmentId(history.getString("attachmentId"))
                .setContentKey(ByteString.copyFrom(history.getString("contentKey").hex()))
                .setNonce(ByteString.copyFrom(history.getString("nonce").hex())))
        }
        assertEquals(bundle, own.build(), "own bundle by decoded value")
    }

    private fun code(v: JSONObject) {
        val decoded = LinkCrypto.decodeCode(v.getString("code"))
        assertEquals(v.getString("sessionId"), decoded.sessionId)
        assertEquals(v.getString("ephemeralPublicKey"), decoded.ephemeralPublicKey.toByteArray().hex())
        assertEquals(v.getString("deviceName"), decoded.deviceName)
        assertEquals(v.getString("deviceName"), ObscuraClient.linkCodeDeviceName(v.getString("code")))

        val own = LinkCode.newBuilder()
            .setSessionId(v.getString("sessionId"))
            .setEphemeralPublicKey(ByteString.copyFrom(v.getString("ephemeralPublicKey").hex()))
            .setDeviceName(v.getString("deviceName"))
            .build()
        assertEquals(own, LinkCrypto.decodeCode(LinkCrypto.encodeCode(own)), "own encoding round trip")
        assertEquals(decoded, own, "vector code by decoded value")
    }

    private fun status(wire: String) = when (wire) {
        "FRIEND_STATUS_PENDING_SENT" -> FriendStatus.PENDING_SENT
        "FRIEND_STATUS_PENDING_RECEIVED" -> FriendStatus.PENDING_RECEIVED
        "FRIEND_STATUS_ACCEPTED" -> FriendStatus.ACCEPTED
        else -> error("unknown status $wire")
    }

    private fun objects(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
}
