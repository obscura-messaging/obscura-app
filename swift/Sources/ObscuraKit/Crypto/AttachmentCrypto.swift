import Foundation
import CryptoKit

public struct UploadedAttachment: Sendable, Equatable {
    public let id: String
    public let contentKey: Data
    public let nonce: Data
}

/// AES-256-GCM without associated data. The ciphertext is `ciphertext || tag`, the nonce travels separately.
public enum AttachmentCrypto {
    private static let tagSize = 16
    private static let safeIdChars = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    private static let extensions = ["jpg", "mp4", "mov"]

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

    private static func safeStem(_ id: String) -> String {
        String(String.UnicodeScalarView(id.unicodeScalars.map { safeIdChars.contains($0) ? $0 : "_" }))
    }

    public static func readCached(cacheDir: URL, id: String) -> URL? {
        let fm = FileManager.default
        let safe = safeStem(id)
        for ext in extensions {
            let c = cacheDir.appendingPathComponent("\(safe).\(ext)")
            if fm.fileExists(atPath: c.path),
               let attrs = try? fm.attributesOfItem(atPath: c.path),
               let sz = attrs[.size] as? Int, sz > 0 {
                return c
            }
        }
        return nil
    }

    public static func writeCached(cacheDir: URL, id: String, data: Data) throws -> URL {
        let fm = FileManager.default
        try? fm.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let safe = safeStem(id)
        var ext = "jpg"
        let head = [UInt8](data.prefix(12))
        if head.count >= 12, head[4] == 0x66, head[5] == 0x74, head[6] == 0x79, head[7] == 0x70 {
            let brand = String(bytes: head[8..<12], encoding: .ascii) ?? ""
            ext = brand == "qt  " ? "mov" : "mp4"
        }
        let dest = cacheDir.appendingPathComponent("\(safe).\(ext)")
        let tmp = cacheDir.appendingPathComponent("\(safe).\(ext).tmp")
        try data.write(to: tmp, options: .atomic)
        if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: dest) }
        try fm.moveItem(at: tmp, to: dest)
        return dest
    }

    public static func purgeCached(cacheDir: URL, id: String) {
        let stem = safeStem(id)
        for ext in extensions {
            try? FileManager.default.removeItem(at: cacheDir.appendingPathComponent("\(stem).\(ext)"))
            try? FileManager.default.removeItem(at: cacheDir.appendingPathComponent("\(stem).\(ext).tmp"))
        }
    }
}
