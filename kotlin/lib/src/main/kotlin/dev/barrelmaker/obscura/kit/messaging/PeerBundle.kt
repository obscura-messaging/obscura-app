package dev.barrelmaker.obscura.kit.messaging

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.crypto.fromBase64
import dev.barrelmaker.obscura.kit.network.isUuid
import org.json.JSONArray
import org.json.JSONObject
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.kem.KEMPublicKey
import org.signal.libsignal.protocol.state.PreKeyBundle

/** One device's prekey bundle, keyed by its device UUID. */
internal data class PeerBundle(val deviceId: String, val bundle: PreKeyBundle)

/** Parse `GET /v1/keys/{userId}`. Each bundle is bound to its own device UUID; there is no fallback. */
internal fun parsePeerBundles(json: JSONArray): List<PeerBundle> =
    (0 until json.length()).map { parsePeerBundle(json.getJSONObject(it)) }.also { bundles ->
        if (bundles.map { it.deviceId }.distinct().size != bundles.size) throw ObscuraError.ProtocolViolation("Duplicate device in bundles")
    }

/** A field missing or malformed, or a key that doesn't decode, is the server breaking the protocol. */
internal fun parsePeerBundle(b: JSONObject): PeerBundle = try {
    decodePeerBundle(b)
} catch (e: org.json.JSONException) {
    throw ObscuraError.ProtocolViolation("Malformed bundle: ${e.message}", e)
} catch (e: org.signal.libsignal.protocol.InvalidKeyException) {
    throw ObscuraError.ProtocolViolation("Invalid key in bundle: ${e.message}", e)
}

private fun decodePeerBundle(b: JSONObject): PeerBundle {
    val spk = b.getJSONObject("signedPreKey")
    val kyber = b.getJSONObject("kyberPreKey")
    val otp = b.optJSONObject("oneTimePreKey")
    val deviceId = b.getString("deviceId")
    if (!isUuid(deviceId)) throw ObscuraError.ProtocolViolation("Invalid device id in bundle")
    return PeerBundle(
        deviceId,
        PreKeyBundle(
            b.getInt("registrationId"), 1,
            otp?.getInt("keyId") ?: PreKeyBundle.NULL_PRE_KEY_ID,
            otp?.let { ECPublicKey(it.getString("publicKey").fromBase64()) },
            spk.getInt("keyId"),
            ECPublicKey(spk.getString("publicKey").fromBase64()),
            spk.getString("signature").fromBase64(),
            IdentityKey(b.getString("identityKey").fromBase64()),
            kyber.getInt("keyId"),
            KEMPublicKey(kyber.getString("publicKey").fromBase64()),
            kyber.getString("signature").fromBase64(),
        ),
    )
}

/** All of a user's bundles carry the account identity, and each signed and Kyber prekey verifies against it. */
internal fun requireConsistent(bundles: List<PeerBundle>) {
    val identity = bundles.firstOrNull()?.bundle?.identityKey ?: return
    for (peer in bundles) {
        val bundle = peer.bundle
        if (bundle.identityKey != identity) throw ObscuraError.ProtocolViolation("Bundles carry different identity keys")
        if (!identity.publicKey.verifySignature(bundle.signedPreKey.serialize(), bundle.signedPreKeySignature)) {
            throw ObscuraError.ProtocolViolation("Signed prekey of device ${peer.deviceId} does not verify")
        }
        if (!identity.publicKey.verifySignature(bundle.kyberPreKey.serialize(), bundle.kyberPreKeySignature)) {
            throw ObscuraError.ProtocolViolation("Kyber prekey of device ${peer.deviceId} does not verify")
        }
    }
}
