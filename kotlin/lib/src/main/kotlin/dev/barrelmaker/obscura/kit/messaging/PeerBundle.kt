package dev.barrelmaker.obscura.kit.messaging

import dev.barrelmaker.obscura.kit.ObscuraError
import dev.barrelmaker.obscura.kit.crypto.fromBase64
import dev.barrelmaker.obscura.kit.network.isUuid
import org.json.JSONArray
import org.json.JSONObject
import org.signal.libsignal.protocol.IdentityKey
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.state.PreKeyBundle

/** One device's prekey bundle, keyed by its device UUID. */
internal data class PeerBundle(val deviceId: String, val bundle: PreKeyBundle)

/** Parse `GET /v1/keys/{userId}`. Each bundle is bound to its own device UUID; there is no fallback. */
internal fun parsePeerBundles(json: JSONArray): List<PeerBundle> =
    (0 until json.length()).map { parsePeerBundle(json.getJSONObject(it)) }.also { bundles ->
        if (bundles.map { it.deviceId }.distinct().size != bundles.size) throw ObscuraError.ProtocolViolation("Duplicate device in bundles")
    }

internal fun parsePeerBundle(b: JSONObject): PeerBundle {
    val spk = b.getJSONObject("signedPreKey")
    val otp = b.optJSONObject("oneTimePreKey")
    val deviceId = b.getString("deviceId")
    if (!isUuid(deviceId)) throw ObscuraError.ProtocolViolation("Invalid device id in bundle")
    return PeerBundle(
        deviceId,
        PreKeyBundle(
            b.getInt("registrationId"), 1,
            otp?.getInt("keyId") ?: 0,
            otp?.let { Curve.decodePoint(it.getString("publicKey").fromBase64(), 0) },
            spk.getInt("keyId"),
            Curve.decodePoint(spk.getString("publicKey").fromBase64(), 0),
            spk.getString("signature").fromBase64(),
            IdentityKey(b.getString("identityKey").fromBase64()),
        ),
    )
}

/** All of a user's bundles carry the account identity, and each signed prekey verifies against it. */
internal fun requireConsistent(bundles: List<PeerBundle>) {
    val identity = bundles.firstOrNull()?.bundle?.identityKey ?: return
    for (peer in bundles) {
        if (peer.bundle.identityKey != identity) throw ObscuraError.ProtocolViolation("Bundles carry different identity keys")
        if (!identity.publicKey.verifySignature(peer.bundle.signedPreKey.serialize(), peer.bundle.signedPreKeySignature)) {
            throw ObscuraError.ProtocolViolation("Signed prekey of device ${peer.deviceId} does not verify")
        }
    }
}
