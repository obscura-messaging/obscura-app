import Foundation
import CryptoKit

public struct UploadedAttachment: Sendable, Equatable {
    public let id: String
    public let contentKey: Data
    public let nonce: Data
}

/// AES-256-GCM without associated data. The ciphertext is `ciphertext || tag`, the nonce travels separately.
enum AttachmentCrypto {
    private static let tagSize = 16

    /// Seals with a fresh key and nonce.
    static func encrypt(_ plaintext: Data) throws -> (ciphertext: Data, contentKey: Data, nonce: Data) {
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let nonce = Data(AES.GCM.Nonce())
        return (try seal(plaintext, key: key, nonce: nonce), key, nonce)
    }

    static func seal(_ plaintext: Data, key: Data, nonce: Data) throws -> Data {
        let sealed = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce))
        return sealed.ciphertext + sealed.tag
    }

    static func open(_ ciphertext: Data, key: Data, nonce: Data) throws -> Data {
        guard ciphertext.count >= tagSize else {
            throw ObscuraError.protocolViolation("ciphertext shorter than its tag")
        }
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce),
                                           ciphertext: ciphertext.dropLast(tagSize), tag: ciphertext.suffix(tagSize))
        return try AES.GCM.open(sealed, using: SymmetricKey(data: key))
    }
}
