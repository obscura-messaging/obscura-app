package dev.barrelmaker.obscura.kit.crypto

import com.google.protobuf.ByteString
import com.google.protobuf.InvalidProtocolBufferException
import dev.barrelmaker.obscura.kit.ObscuraError
import obscura.client.v1.Client.LinkCode
import obscura.client.v1.Client.LinkEnvelope
import org.signal.libsignal.protocol.InvalidKeyException
import org.signal.libsignal.protocol.ecc.Curve
import org.signal.libsignal.protocol.ecc.ECKeyPair
import org.signal.libsignal.protocol.ecc.ECPrivateKey
import org.signal.libsignal.protocol.ecc.ECPublicKey
import org.signal.libsignal.protocol.kdf.HKDF
import java.security.GeneralSecurityException
import java.util.Base64

/** The device-link envelope and code. Pinned by `protocol/conformance/link.json`. */
internal object LinkCrypto {
    private val INFO = "Obscura link v1".toByteArray()
    private const val KEY_SIZE = 32

    fun key(sharedSecret: ByteArray): ByteArray = HKDF.deriveSecrets(sharedSecret, ByteArray(0), INFO, KEY_SIZE)

    /** Encrypt a serialized `LinkBundle` to [peer]. [ephemeral] and [nonce] are fresh except in conformance tests. */
    fun seal(
        plaintext: ByteArray,
        peer: ECPublicKey,
        ephemeral: ECKeyPair = Curve.generateKeyPair(),
        nonce: ByteArray = AttachmentCrypto.randomNonce(),
    ): LinkEnvelope {
        val key = key(Curve.calculateAgreement(peer, ephemeral.privateKey))
        return LinkEnvelope.newBuilder()
            .setEphemeralPublicKey(ByteString.copyFrom(ephemeral.publicKey.serialize()))
            .setNonce(ByteString.copyFrom(nonce))
            .setCiphertext(ByteString.copyFrom(AttachmentCrypto.encrypt(plaintext, key, nonce)))
            .build()
    }

    /** The serialized `LinkBundle` in [envelope]; [ObscuraError.LinkFailed] when it does not decrypt. */
    fun open(envelope: ByteArray, own: ECPrivateKey): ByteArray = try {
        val parsed = LinkEnvelope.parseFrom(envelope)
        if (parsed.nonce.size() != AttachmentCrypto.NONCE_SIZE) {
            throw ObscuraError.LinkFailed("Link envelope nonce has invalid length")
        }
        val peer = Curve.decodePoint(parsed.ephemeralPublicKey.toByteArray(), 0)
        AttachmentCrypto.decrypt(parsed.ciphertext.toByteArray(), key(Curve.calculateAgreement(peer, own)), parsed.nonce.toByteArray())
    } catch (e: InvalidProtocolBufferException) {
        throw ObscuraError.LinkFailed("Link envelope is malformed", e)
    } catch (e: InvalidKeyException) {
        throw ObscuraError.LinkFailed("Link envelope key is invalid", e)
    } catch (e: GeneralSecurityException) {
        throw ObscuraError.LinkFailed("Link envelope does not decrypt", e)
    } catch (e: IllegalArgumentException) {
        throw ObscuraError.LinkFailed("Link envelope is invalid", e)
    }

    fun encodeCode(code: LinkCode): String = Base64.getUrlEncoder().withoutPadding().encodeToString(code.toByteArray())

    /** Base64url without padding of a `LinkCode` whose key is a libsignal public key. */
    fun decodeCode(text: String): LinkCode {
        val code = try {
            if ('=' in text) throw IllegalArgumentException("padded")
            LinkCode.parseFrom(Base64.getUrlDecoder().decode(text))
        } catch (e: IllegalArgumentException) {
            throw ObscuraError.InvalidArgument("Invalid link code")
        } catch (e: InvalidProtocolBufferException) {
            throw ObscuraError.InvalidArgument("Invalid link code")
        }
        if (code.sessionId.isEmpty() || runCatching { publicKey(code) }.isFailure) throw ObscuraError.InvalidArgument("Invalid link code")
        return code
    }

    fun publicKey(code: LinkCode): ECPublicKey = Curve.decodePoint(code.ephemeralPublicKey.toByteArray(), 0)
}
