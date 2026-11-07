import Foundation
import Security
import XCTest
@testable import ObscuraKit

final class AttachmentCryptoTests: XCTestCase {
    func testAttachmentCryptoEncryptAndOpenRoundTrip() throws {
        let plaintext = Data("hello attachment world".utf8)
        let encrypted = try AttachmentCrypto.encrypt(plaintext)
        XCTAssertEqual(encrypted.contentKey.count, 32)
        XCTAssertEqual(encrypted.nonce.count, 12)
        let opened = try AttachmentCrypto.open(encrypted.ciphertext, key: encrypted.contentKey, nonce: encrypted.nonce)
        XCTAssertEqual(opened, plaintext)
    }

    func testAttachmentCryptoRejectsShortTamperedOrMismatchedKeyAndNonce() throws {
        let encrypted = try AttachmentCrypto.encrypt(Data("hello attachment world".utf8))

        XCTAssertThrowsError(try AttachmentCrypto.open(Data([1, 2, 3]), key: encrypted.contentKey, nonce: encrypted.nonce)) {
            XCTAssertEqual($0 as? ObscuraError, .protocolViolation("ciphertext shorter than its tag"))
        }
        XCTAssertThrowsError(try AttachmentCrypto.open(encrypted.ciphertext, key: encrypted.contentKey, nonce: Data([1, 2])))
        XCTAssertThrowsError(try AttachmentCrypto.open(encrypted.ciphertext, key: Data(repeating: 9, count: 32), nonce: encrypted.nonce))
        var tampered = Data(encrypted.ciphertext)
        tampered[0] ^= 0xff
        XCTAssertThrowsError(try AttachmentCrypto.open(tampered, key: encrypted.contentKey, nonce: encrypted.nonce))
    }

    func testAttachmentCryptoWriteReadAndPurgeCachedFilesByMediaFormat() throws {
        let cacheDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".crypto-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: cacheDir) }

        AttachmentCrypto.purgeAllCached(cacheDir: cacheDir)
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "missing"))

        let jpgUrl = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: "../att:jpg?1", data: Data([0xff, 0xd8, 0xff]))
        XCTAssertEqual(jpgUrl.pathExtension, "jpg")
        XCTAssertEqual(jpgUrl.lastPathComponent, "___att_jpg_1.jpg")
        let jpgUrl2 = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: "../att:jpg?1", data: Data([0xff, 0xd8, 0xff, 0x00]))
        XCTAssertEqual(jpgUrl2, jpgUrl)
        XCTAssertEqual(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "../att:jpg?1"), jpgUrl)

        let mp4Header = Data([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2])
        let mp4Url = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: "vid_mp4", data: mp4Header)
        XCTAssertEqual(mp4Url.pathExtension, "mp4")
        XCTAssertEqual(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mp4"), mp4Url)

        let movHeader = Data([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 1, 2])
        let movUrl = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: "vid_mov", data: movHeader)
        XCTAssertEqual(movUrl.pathExtension, "mov")
        XCTAssertEqual(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mov"), movUrl)

        let strayTmp = cacheDir.appendingPathComponent("vid_mp4.mp4.extra.tmp")
        try Data([1]).write(to: strayTmp)
        AttachmentCrypto.purgeCached(cacheDir: cacheDir, id: "vid_mp4")
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mp4"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: strayTmp.path))
        XCTAssertNotNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mov"))

        AttachmentCrypto.purgeAllCached(cacheDir: cacheDir)
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mov"))
    }

    func testDatabaseSecretCreatesReusesReplacesShortKeyAndOpensSQLCipherClient() throws {
        let userId = "unit-test-\(UUID().uuidString.lowercased())"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.barrelmaker.obscura.kit.dbsecret",
            kSecAttrAccount as String: "db_key_\(userId)",
        ]
        defer { SecItemDelete(query as CFDictionary) }

        let key1 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key1.count, 32)
        let key2 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key2, key1)
        let keyWithGroup = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: "test.group")
        XCTAssertEqual(keyWithGroup, key1)

        SecItemDelete(query as CFDictionary)
        var shortAdd = query
        shortAdd[kSecValueData as String] = Data([1, 2, 3])
        XCTAssertEqual(SecItemAdd(shortAdd as CFDictionary, nil), errSecSuccess)
        let key3 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key3.count, 32)

        let dataDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".client-dir-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dataDir) }

        let client = try ObscuraClient(
            apiURL: "https://obscura.invalid",
            dataDirectory: dataDir.path,
            userId: userId,
            keychainAccessGroup: nil,
            deviceName: "mac-test",
            sessionStorage: MemorySessionStorage(),
            logger: SilentLogger(),
            attachmentCacheDir: dataDir.appendingPathComponent("cache")
        )
        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dataDir.appendingPathComponent("obscura.sqlite").path))
        XCTAssertEqual(questionMarks(3), "?, ?, ?")
    }

    func testConstantTimeEqualComparesContentAndLength() {
        XCTAssertFalse(constantTimeEqual(Data([1, 2]), Data([1, 2, 3])))
        XCTAssertFalse(constantTimeEqual(Data([1, 2, 4]), Data([1, 2, 3])))
        XCTAssertTrue(constantTimeEqual(Data([1, 2, 3]), Data([1, 2, 3])))
    }
}
