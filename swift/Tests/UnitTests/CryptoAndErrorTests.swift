import Foundation
import Security
import GRDB
import LibSignalClient
import XCTest
@testable import ObscuraKit

final class CryptoAndErrorTests: XCTestCase {
    func testAllObscuraErrorCodesAndDescriptions() {
        let cases: [(ObscuraError, String, String)] = [
            (.notAuthenticated, "NOT_AUTHENTICATED", "Not authenticated"),
            (.invalidArgument("bad arg"), "INVALID_ARGUMENT", "Invalid argument: bad arg"),
            (.invalidFriendCode, "INVALID_FRIEND_CODE", "Invalid friend code"),
            (.http(status: 418, body: "teapot"), "HTTP_ERROR", "HTTP 418: teapot"),
            (.connectionFailed("down"), "CONNECTION_FAILED", "Connection failed: down"),
            (.sendFailed("no peers"), "SEND_FAILED", "Send failed: no peers"),
            (.protocolViolation("bad wire"), "PROTOCOL_VIOLATION", "Protocol violation: bad wire"),
            (.storageFailed("io err"), "STORAGE_ERROR", "Storage failed: io err"),
            (.notPrimary, "NOT_PRIMARY", "Only the primary device can do this"),
            (.linkFailed("expired"), "LINK_FAILED", "Link failed: expired"),
        ]
        for (error, expectedCode, expectedDescription) in cases {
            XCTAssertEqual(error.code, expectedCode)
            XCTAssertEqual(error.errorDescription, expectedDescription)
            XCTAssertEqual(error.localizedDescription, expectedDescription)
        }
    }

    func testAttachmentCryptoEncryptOpenAndCacheOperations() throws {
        let plaintext = Data("hello attachment world".utf8)
        let encrypted = try AttachmentCrypto.encrypt(plaintext)
        XCTAssertEqual(encrypted.contentKey.count, 32)
        XCTAssertEqual(encrypted.nonce.count, 12)
        let opened = try AttachmentCrypto.open(encrypted.ciphertext, key: encrypted.contentKey, nonce: encrypted.nonce)
        XCTAssertEqual(opened, plaintext)

        // Short ciphertext (< 16-byte tag) throws protocolViolation.
        XCTAssertThrowsError(try AttachmentCrypto.open(Data([1, 2, 3]), key: encrypted.contentKey, nonce: encrypted.nonce)) {
            XCTAssertEqual($0 as? ObscuraError, .protocolViolation("ciphertext shorter than its tag"))
        }
        // Wrong nonce length or wrong 32-byte key or tampered ciphertext fails to open.
        XCTAssertThrowsError(try AttachmentCrypto.open(encrypted.ciphertext, key: encrypted.contentKey, nonce: Data([1, 2])))
        XCTAssertThrowsError(try AttachmentCrypto.open(encrypted.ciphertext, key: Data(repeating: 9, count: 32), nonce: encrypted.nonce))
        var tampered = Data(encrypted.ciphertext)
        tampered[0] ^= 0xff
        XCTAssertThrowsError(try AttachmentCrypto.open(tampered, key: encrypted.contentKey, nonce: encrypted.nonce))

        let cacheDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".crypto-cache-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: cacheDir) }

        // Purging non-existent cacheDir is a safe no-op.
        AttachmentCrypto.purgeAllCached(cacheDir: cacheDir)
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "missing"))

        // Write JPEG (default), MP4 (ftypisom), and MOV (ftypqt  ) attachments.
        let jpgUrl = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: "../att:jpg?1", data: Data([0xff, 0xd8, 0xff]))
        XCTAssertEqual(jpgUrl.pathExtension, "jpg")
        XCTAssertEqual(jpgUrl.lastPathComponent, "___att_jpg_1.jpg")
        // Overwriting existing file succeeds.
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

        // Create a stray .tmp file for vid_mp4 and verify purgeCached removes both .mp4 and .tmp.
        let strayTmp = cacheDir.appendingPathComponent("vid_mp4.mp4.extra.tmp")
        try Data([1]).write(to: strayTmp)
        AttachmentCrypto.purgeCached(cacheDir: cacheDir, id: "vid_mp4")
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mp4"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: strayTmp.path))
        XCTAssertNotNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mov"))

        AttachmentCrypto.purgeAllCached(cacheDir: cacheDir)
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: "vid_mov"))
    }

    func testDatabaseSecretAndFileBackedClientInit() throws {
        let userId = "unit-test-\(UUID().uuidString.lowercased())"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.barrelmaker.obscura.kit.dbsecret",
            kSecAttrAccount as String: "db_key_\(userId)",
        ]
        defer { SecItemDelete(query as CFDictionary) }

        // First call with accessGroup: nil generates and stores a 32-byte key; second call returns it.
        let key1 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key1.count, 32)
        let key2 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key2, key1)
        let keyWithGroup = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: "test.group")
        XCTAssertEqual(keyWithGroup, key1)

        // A stored key of wrong length is replaced with a fresh 32-byte key.
        SecItemDelete(query as CFDictionary)
        var shortAdd = query
        shortAdd[kSecValueData as String] = Data([1, 2, 3])
        XCTAssertEqual(SecItemAdd(shortAdd as CFDictionary, nil), errSecSuccess)
        let key3 = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: nil)
        XCTAssertEqual(key3.count, 32)

        // File-backed ObscuraClient initializer opens SQLCipher database in dataDirectory.
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

    func testHelpersLoggerSignalStoreAndMessengerValidation() async throws {
        // ConstantTime different-length guard
        XCTAssertFalse(constantTimeEqual(Data([1, 2]), Data([1, 2, 3])))
        XCTAssertTrue(constantTimeEqual(Data([1, 2, 3]), Data([1, 2, 3])))

        // LinkCrypto invalid nonce length
        var badEnvelope = Obscura_Client_V1_LinkEnvelope()
        badEnvelope.ephemeralPublicKey = Data(PrivateKey.generate().publicKey.serialize())
        badEnvelope.nonce = Data([1, 2, 3])
        badEnvelope.ciphertext = Data(repeating: 0, count: 32)
        XCTAssertThrowsError(try LinkCrypto.open(badEnvelope, with: PrivateKey.generate())) {
            XCTAssertEqual($0 as? ObscuraError, .linkFailed("envelope nonce has invalid length"))
        }

        // RecordingLogger methods
        let logger = RecordingLogger(SilentLogger())
        logger.ackFailed(envelopeId: "env1", reason: "closed")
        logger.preKeyReplenishFailed(reason: "500")
        logger.decryptFailed(sourceUserId: "u1", reason: "bad mac")
        logger.tokenRefreshFailed(attempt: 2, reason: "timeout")
        logger.identityChanged(userId: "u2")
        logger.sessionEstablishFailed(userId: "u3", reason: "404")
        logger.databaseError(store: "s", operation: "op", reason: "locked")
        let logLines = logger.snapshot()
        XCTAssertEqual(logLines.count, 7)
        XCTAssertTrue(logLines.contains("ack failed for env1: closed"))
        XCTAssertTrue(logLines.contains("prekey replenish failed: 500"))

        // SubmitOutcome convenience init
        let outcomeEmpty = SubmitOutcome(submitted: [], missingDeviceIds: [])
        XCTAssertTrue(outcomeEmpty.missingDeviceIds.isEmpty)
        let outcomeMissing = SubmitOutcome(submitted: [], missingDeviceIds: ["d1"])
        XCTAssertEqual(outcomeMissing.missingDeviceIds, ["d1"])

        // PersistentSignalStore protocol methods & Kyber stubs
        let store = try signalStoreWithIdentity()
        let keys = try SignalKeys.generate()
        try store.storePreKey(keys.preKeys[0], id: 999, context: NullContext())
        XCTAssertNoThrow(try store.loadPreKey(id: 999, context: NullContext()))
        try store.storeSignedPreKey(keys.signedPreKey, id: 888, context: NullContext())
        XCTAssertNoThrow(try store.loadSignedPreKey(id: 888, context: NullContext()))
        let existingSessions = try store.loadExistingSessions(
            for: [ProtocolAddress(name: "missing", deviceId: 1)], context: NullContext()
        )
        XCTAssertTrue(existingSessions.isEmpty)
        XCTAssertThrowsError(try store.loadKyberPreKey(id: 1, context: NullContext()))
        XCTAssertThrowsError(try store.markKyberPreKeyUsed(id: 1, context: NullContext()))

        // Messenger bundle & encryption validation
        let validIdentity = keys.identity
        let validSigned = keys.signedPreKey
        let validDeviceId = UUID().uuidString.lowercased()
        let bundleNoOneTime = PreKeyBundleResponse(
            deviceId: validDeviceId,
            registrationId: Int(keys.registrationId),
            identityKey: Data(validIdentity.publicKey.serialize()).base64EncodedString(),
            signedPreKey: .init(
                keyId: Int(validSigned.id),
                publicKey: Data(validSigned.publicKey.serialize()).base64EncodedString(),
                signature: Data(validSigned.signature).base64EncodedString()
            ),
            oneTimePreKey: nil
        )
        let verified = try Messenger.verifiedBundles([bundleNoOneTime])
        XCTAssertEqual(verified.count, 1)

        // Duplicate deviceId
        XCTAssertThrowsError(try Messenger.verifiedBundles([bundleNoOneTime, bundleNoOneTime]))
        // Invalid UUID deviceId
        let badIdBundle = PreKeyBundleResponse(
            deviceId: "not-uuid", registrationId: 1, identityKey: "",
            signedPreKey: .init(keyId: 1, publicKey: "", signature: ""), oneTimePreKey: nil
        )
        XCTAssertThrowsError(try Messenger.verifiedBundles([badIdBundle]))
        // Invalid base64
        let badBase64Bundle = PreKeyBundleResponse(
            deviceId: validDeviceId, registrationId: 1, identityKey: "!!!",
            signedPreKey: .init(keyId: 1, publicKey: "!!!", signature: "!!!"), oneTimePreKey: nil
        )
        XCTAssertThrowsError(try Messenger.verifiedBundles([badBase64Bundle]))
        // Invalid one-time prekey base64
        let badOneTimeBundle = PreKeyBundleResponse(
            deviceId: validDeviceId,
            registrationId: Int(keys.registrationId),
            identityKey: Data(validIdentity.publicKey.serialize()).base64EncodedString(),
            signedPreKey: .init(
                keyId: Int(validSigned.id),
                publicKey: Data(validSigned.publicKey.serialize()).base64EncodedString(),
                signature: Data(validSigned.signature).base64EncodedString()
            ),
            oneTimePreKey: .init(keyId: 1, publicKey: "!!!")
        )
        XCTAssertThrowsError(try Messenger.verifiedBundles([badOneTimeBundle]))

        let api = try APIClient(baseURL: "https://obscura.invalid")
        let messenger = Messenger(api: api, store: store)
        await assertThrows(.protocolViolation("device id not-uuid is not a UUID")) {
            _ = try await messenger.prepareSubmission(deviceId: "not-uuid", clientMessage: Data())
        }
        var unspecifiedEncrypted = Obscura_Client_V1_EncryptedMessage()
        unspecifiedEncrypted.type = .unspecified
        await assertThrows(.protocolViolation("encrypted message type 0")) {
            _ = try await messenger.decrypt(senderDeviceUuid: validDeviceId, unspecifiedEncrypted)
        }
        var sub = Obscura_V1_SendMessageRequest.Submission()
        sub.deviceID = uuidBytes(validDeviceId)!
        let badSubmit = await messenger.submit(userIds: ["not-a-uuid"], submissions: [UserSubmission(userId: "not-a-uuid", submission: sub)])
        XCTAssertEqual(badSubmit.submitted.first?.result.status, .rejected)

        let sender = MessageSender(
            messenger: messenger, devices: DeviceStore(db: try ObscuraDatabase.inMemory()),
            api: api, logger: logger, selfDeviceId: validDeviceId
        )
        let badUserResults = await sender.send(to: "not-a-uuid", Data([1]))
        XCTAssertEqual(badUserResults.first?.status, .rejected)
    }
}
