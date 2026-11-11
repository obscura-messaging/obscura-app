package dev.barrelmaker.obscura.kit.wire

import com.google.protobuf.ByteString
import dev.barrelmaker.obscura.kit.ObscuraClient
import dev.barrelmaker.obscura.kit.crypto.LinkCrypto
import dev.barrelmaker.obscura.kit.stores.Friend
import dev.barrelmaker.obscura.kit.stores.FriendStatus
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
import org.signal.libsignal.protocol.ecc.ECPublicKey
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
        assertEquals(v.getString("newDevicePublicKey"), newDevice.getPublicKey().serialize().hex(), "new device public key")
        assertEquals(v.getString("primaryPublicKey"), primary.getPublicKey().serialize().hex(), "primary public key")

        val newDevicePublic = ECPublicKey(v.getString("newDevicePublicKey").hex())
        val primaryPublic = ECPublicKey(v.getString("primaryPublicKey").hex())
        val shared = newDevice.calculateAgreement(primaryPublic)
        assertEquals(v.getString("sharedSecret"), shared.hex(), "shared secret from the new device")
        assertEquals(v.getString("sharedSecret"), primary.calculateAgreement(newDevicePublic).hex(), "shared secret from the primary")
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
            Friend(it.getString("userId"), it.getString("username"), status(it.getString("status")))
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

    @org.junit.jupiter.api.Test
    fun `LinkCrypto open rejects malformed protobuf, invalid nonce length, and invalid ephemeral public key`() {
        val own = ECKeyPair.generate().privateKey
        org.junit.jupiter.api.Assertions.assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.LinkFailed::class.java) {
            LinkCrypto.open(byteArrayOf(-1, -1, -1), own)
        }
        val badNonceEnv = LinkEnvelope.newBuilder()
            .setNonce(ByteString.copyFrom(byteArrayOf(1, 2, 3)))
            .build()
        org.junit.jupiter.api.Assertions.assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.LinkFailed::class.java) {
            LinkCrypto.open(badNonceEnv.toByteArray(), own)
        }
        val badKeyEnv = LinkEnvelope.newBuilder()
            .setNonce(ByteString.copyFrom(ByteArray(12)))
            .setEphemeralPublicKey(ByteString.copyFrom(byteArrayOf(1, 2, 3)))
            .build()
        org.junit.jupiter.api.Assertions.assertThrows(dev.barrelmaker.obscura.kit.ObscuraError.LinkFailed::class.java) {
            LinkCrypto.open(badKeyEnv.toByteArray(), own)
        }
    }
}
