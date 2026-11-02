import Foundation
import CryptoKit
import LibSignalClient

/// The device-link envelope and code, pinned by `protocol/conformance/link.json`.
enum LinkCrypto {
    private static let info = Data("Obscura link v1".utf8)

    /// HKDF-SHA256 (empty salt) of the X25519 agreement.
    static func key(privateKey: PrivateKey, peerPublicKey: PublicKey) -> Data {
        let shared = SymmetricKey(data: privateKey.keyAgreement(with: peerPublicKey))
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: shared, salt: Data(), info: info, outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
    }

    static func seal(_ bundle: Data, to peerPublicKey: PublicKey, ephemeral: PrivateKey = .generate(),
                     nonce: Data = Data(AES.GCM.Nonce())) throws -> Obscura_Client_V1_LinkEnvelope {
        var envelope = Obscura_Client_V1_LinkEnvelope()
        envelope.ephemeralPublicKey = Data(ephemeral.publicKey.serialize())
        envelope.nonce = nonce
        envelope.ciphertext = try AttachmentCrypto.seal(bundle, key: key(privateKey: ephemeral, peerPublicKey: peerPublicKey),
                                                        nonce: nonce)
        return envelope
    }

    static func open(_ envelope: Obscura_Client_V1_LinkEnvelope, with privateKey: PrivateKey) throws -> Data {
        guard envelope.nonce.count == 12 else {
            throw ObscuraError.linkFailed("envelope nonce has invalid length")
        }
        do {
            let peer = try PublicKey(envelope.ephemeralPublicKey)
            return try AttachmentCrypto.open(envelope.ciphertext, key: key(privateKey: privateKey, peerPublicKey: peer),
                                             nonce: envelope.nonce)
        } catch {
            throw ObscuraError.linkFailed("envelope does not decrypt: \(error)")
        }
    }

    /// base64url without padding of the serialized `LinkCode`.
    static func encode(_ code: Obscura_Client_V1_LinkCode) throws -> String {
        try code.serializedData().base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ string: String) throws -> Obscura_Client_V1_LinkCode {
        var base64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        guard !string.contains("="), let data = Data(base64Encoded: base64),
              let code = try? Obscura_Client_V1_LinkCode(serializedBytes: data),
              !code.sessionID.isEmpty, (try? PublicKey(code.ephemeralPublicKey)) != nil else {
            throw ObscuraError.invalidArgument("link code")
        }
        return code
    }
}
