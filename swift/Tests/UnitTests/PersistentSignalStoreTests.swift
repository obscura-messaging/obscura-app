import XCTest
import GRDB
import LibSignalClient
@testable import ObscuraKit

final class PersistentSignalStoreTests: XCTestCase {
    private func store(_ db: DatabaseQueue? = nil, listing devices: [String: String] = [:],
                       logger: ObscuraLogger = SilentLogger()) throws -> PersistentSignalStore {
        let db = try db ?? ObscuraDatabase.inMemory()
        try db.write { db in
            for (deviceId, userId) in devices { try DeviceStore.add(userId: userId, deviceId: deviceId, in: db) }
        }
        return PersistentSignalStore(db: db, logger: logger)
    }

    /// Installs fresh keys in `peer` and returns a bundle for them using its first one-time prekey.
    private func bundle(installingIn peer: PersistentSignalStore, identity: IdentityKeyPair = .generate()) throws -> PreKeyBundle {
        let keys = try SignalKeys.generate(identity: identity)
        try peer.install(keys)
        return try PreKeyBundle(
            registrationId: keys.registrationId, deviceId: 1, prekeyId: keys.preKeys[0].id, prekey: keys.preKeys[0].publicKey,
            signedPrekeyId: keys.signedPreKey.id, signedPrekey: keys.signedPreKey.publicKey,
            signedPrekeySignature: keys.signedPreKey.signature, identity: keys.identity.identityKey)
    }

    // MARK: - Identity

    func testInstallPersistsTheIdentityAndItsKeysAcrossStores() throws {
        let db = try ObscuraDatabase.inMemory()
        let first = try store(db)
        XCTAssertFalse(try first.hasIdentity())
        let keys = try SignalKeys.generate()

        try first.install(keys)

        let reopened = try store(db)
        XCTAssertTrue(try reopened.hasIdentity())
        XCTAssertEqual(try reopened.identityKeyPair(context: NullContext()).serialize(), keys.identity.serialize())
        XCTAssertEqual(try reopened.localRegistrationId(context: NullContext()), keys.registrationId)
        XCTAssertEqual(try reopened.preKeyCount(), Int(SignalKeys.initialPreKeyCount))
        XCTAssertEqual(try reopened.loadSignedPreKey(id: PersistentSignalStore.signedPreKeyId, context: NullContext()).serialize(),
                       keys.signedPreKey.serialize())
    }

    func testInstallReplacesEveryEarlierRecord() throws {
        let store = try store(listing: ["peer": "peer-user"])
        try store.install(SignalKeys.generate())
        let peerAddress = try ProtocolAddress(name: "peer", deviceId: 1)
        try processPreKeyBundle(bundle(installingIn: try self.store()), for: peerAddress,
                                sessionStore: store, identityStore: store, context: NullContext())
        XCTAssertNotNil(try store.loadSession(for: peerAddress, context: NullContext()))

        let replacement = try SignalKeys.generate()
        try store.install(replacement)

        XCTAssertEqual(try store.identityKeyPair(context: NullContext()).serialize(), replacement.identity.serialize())
        XCTAssertNil(try store.loadSession(for: peerAddress, context: NullContext()))
        XCTAssertNil(try store.identity(for: peerAddress, context: NullContext()))
    }

    func testAMissingIdentityThrows() throws {
        let store = try store()
        XCTAssertThrowsError(try store.identityKeyPair(context: NullContext()))
        XCTAssertThrowsError(try store.localRegistrationId(context: NullContext()))
    }

    // MARK: - Identity trust (per account, Signal's policy for unverified contacts)

    func testTheFirstIdentityOfAnAccountIsTrustedAndSharedByItsDevices() throws {
        let logger = RecordingLogger(SilentLogger())
        let store = try store(listing: ["phone": "alice", "laptop": "alice"], logger: logger)
        let identity = IdentityKey(publicKey: PrivateKey.generate().publicKey)
        let phone = try ProtocolAddress(name: "phone", deviceId: 1)
        let laptop = try ProtocolAddress(name: "laptop", deviceId: 1)

        XCTAssertTrue(try store.isTrustedIdentity(identity, for: phone, direction: .receiving, context: NullContext()))
        XCTAssertFalse(try store.saveIdentity(identity, for: phone, context: NullContext()), "the first key is not a change")
        XCTAssertFalse(try store.saveIdentity(identity, for: laptop, context: NullContext()), "a linked device shares it")
        XCTAssertEqual(try store.identity(for: laptop, context: NullContext()), identity)
        XCTAssertTrue(logger.snapshot().isEmpty)
    }

    func testADifferentIdentityIsAcceptedForTheWholeAccountDroppingItsSessionsAndLogged() throws {
        let logger = RecordingLogger(SilentLogger())
        let store = try store(listing: ["phone": "alice", "laptop": "alice", "bob-phone": "bob"], logger: logger)
        try store.install(SignalKeys.generate())
        let alice = IdentityKeyPair.generate()
        for (name, identity) in [("phone", alice), ("laptop", alice), ("bob-phone", IdentityKeyPair.generate())] {
            try processPreKeyBundle(bundle(installingIn: try self.store(), identity: identity),
                                    for: ProtocolAddress(name: name, deviceId: 1),
                                    sessionStore: store, identityStore: store, context: NullContext())
        }
        XCTAssertTrue(logger.snapshot().isEmpty, "devices of one account share its identity")
        let replacement = IdentityKey(publicKey: PrivateKey.generate().publicKey)
        let phone = try ProtocolAddress(name: "phone", deviceId: 1)

        XCTAssertTrue(try store.isTrustedIdentity(replacement, for: phone, direction: .sending, context: NullContext()))
        XCTAssertTrue(try store.saveIdentity(replacement, for: phone, context: NullContext()))

        XCTAssertEqual(try store.identity(for: phone, context: NullContext()), replacement)
        XCTAssertThrowsError(try store.identity(for: ProtocolAddress(name: "laptop", deviceId: 1), context: NullContext()))
        XCTAssertNil(try store.loadSession(for: phone, context: NullContext()))
        XCTAssertNil(try store.loadSession(for: ProtocolAddress(name: "laptop", deviceId: 1), context: NullContext()))
        XCTAssertNotNil(try store.loadSession(for: ProtocolAddress(name: "bob-phone", deviceId: 1), context: NullContext()),
                        "another account is untouched")
        XCTAssertEqual(logger.snapshot(), ["identity changed for alice"])
    }

    func testAnAddressOutsideTheDirectoryHasNoTrustDecision() throws {
        let store = try store()
        let identity = IdentityKey(publicKey: PrivateKey.generate().publicKey)
        let stranger = try ProtocolAddress(name: "stranger", deviceId: 1)
        XCTAssertThrowsError(try store.saveIdentity(identity, for: stranger, context: NullContext()))
        XCTAssertThrowsError(try store.identity(for: stranger, context: NullContext()))
    }

    // MARK: - Prekeys

    func testRemovedAndMissingPreKeysThrowOnLoad() throws {
        let store = try store()
        try store.install(SignalKeys.generate())

        XCTAssertNoThrow(try store.loadPreKey(id: 7, context: NullContext()))
        try store.removePreKey(id: 7, context: NullContext())

        XCTAssertThrowsError(try store.loadPreKey(id: 7, context: NullContext()))
        XCTAssertThrowsError(try store.loadPreKey(id: 999, context: NullContext()))
        XCTAssertThrowsError(try store.loadSignedPreKey(id: 999, context: NullContext()))
        XCTAssertEqual(try store.preKeyCount(), 99)
    }

    func testRefillsAdvanceTheServerSignedPreKeyIdAcrossStoreReloads() throws {
        let db = try ObscuraDatabase.inMemory()
        let store = try store(db)
        let keys = try SignalKeys.generate()
        try store.install(keys)
        var serverMaxId = Int(keys.signedPreKey.id)
        var records = [keys.signedPreKey.id: Data(keys.signedPreKey.serialize())]

        for refill in 0..<3 {
            let reopened = try self.store(db)
            let upload = try reopened.addPreKeys(50)

            XCTAssertGreaterThan(upload.signedPreKey.keyId, serverMaxId, "the server rejects an equal or lower signed prekey id")
            XCTAssertEqual(upload.signedPreKey.keyId, serverMaxId + 1)
            XCTAssertEqual(upload.oneTimePreKeys.map(\.keyId), Array((101 + refill * 50)...(150 + refill * 50)))
            XCTAssertEqual(try reopened.preKeyCount(), 150 + refill * 50)
            let signed = try reopened.loadSignedPreKey(id: UInt32(upload.signedPreKey.keyId), context: NullContext())
            XCTAssertEqual(upload.signedPreKey.publicKey, Data(signed.publicKey.serialize()).base64EncodedString())
            XCTAssertEqual(upload.signedPreKey.signature, Data(signed.signature).base64EncodedString())
            XCTAssertTrue(try keys.identity.publicKey.verifySignature(message: signed.publicKey.serialize(), signature: signed.signature))
            for (id, bytes) in records {
                XCTAssertEqual(try reopened.loadSignedPreKey(id: id, context: NullContext()).serialize(), Array(bytes))
            }
            serverMaxId = upload.signedPreKey.keyId
            records[signed.id] = Data(signed.serialize())
        }
    }

    func testRefillAfterAnUnpublishedAttemptDoesNotReuseItsSignedPreKeyId() throws {
        let db = try ObscuraDatabase.inMemory()
        let store = try store(db)
        try store.install(SignalKeys.generate())
        let unpublished = try store.addPreKeys(50)

        let reopened = try self.store(db)
        let retry = try reopened.addPreKeys(50)

        XCTAssertEqual(retry.signedPreKey.keyId, 3)
        XCTAssertGreaterThan(retry.signedPreKey.keyId, unpublished.signedPreKey.keyId)
        XCTAssertEqual(retry.oneTimePreKeys.map(\.keyId), Array(151...200))
        XCTAssertNoThrow(try reopened.loadSignedPreKey(id: UInt32(unpublished.signedPreKey.keyId), context: NullContext()))
    }

    func testOlderSignedPreKeysStayForTheGracePeriodAfterANewerOneIsPublished() throws {
        let grace = PersistentSignalStore.signedPreKeyGraceMs
        let store = try store()
        try store.install(SignalKeys.generate())
        let second = try store.addPreKeys(50).signedPreKey.keyId
        try store.retireSignedPreKeys(publishedId: second, nowMs: 0)

        try store.retireSignedPreKeys(publishedId: second, nowMs: grace - 1)
        XCTAssertNoThrow(try store.loadSignedPreKey(id: 1, context: NullContext()))

        try store.retireSignedPreKeys(publishedId: second, nowMs: grace)
        XCTAssertThrowsError(try store.loadSignedPreKey(id: 1, context: NullContext()))
        XCTAssertNoThrow(try store.loadSignedPreKey(id: UInt32(second), context: NullContext()))
    }

    func testTheGracePeriodRunsFromTheFirstPublishThatSupersededAKey() throws {
        let grace = PersistentSignalStore.signedPreKeyGraceMs
        let store = try store()
        try store.install(SignalKeys.generate())
        let second = try store.addPreKeys(50).signedPreKey.keyId
        try store.retireSignedPreKeys(publishedId: second, nowMs: 0)
        let unpublished = try store.addPreKeys(50).signedPreKey.keyId
        let third = try store.addPreKeys(50).signedPreKey.keyId

        try store.retireSignedPreKeys(publishedId: third, nowMs: grace)

        XCTAssertThrowsError(try store.loadSignedPreKey(id: 1, context: NullContext()))
        for id in [second, unpublished, third] {
            XCTAssertNoThrow(try store.loadSignedPreKey(id: UInt32(id), context: NullContext()))
        }
    }

    func testAMessageUsingAnEarlierBundleDecryptsAfterSignedPreKeyRotation() throws {
        let alice = try store(listing: ["bob": "bob-user"])
        try alice.install(SignalKeys.generate())
        let db = try ObscuraDatabase.inMemory()
        let bob = try store(db, listing: ["alice": "alice-user"])
        let bobAddress = try ProtocolAddress(name: "bob", deviceId: 1)
        try processPreKeyBundle(bundle(installingIn: bob), for: bobAddress,
                                sessionStore: alice, identityStore: alice, context: NullContext())
        let cipher = try signalEncrypt(message: Array("delayed message".utf8), for: bobAddress,
                                       sessionStore: alice, identityStore: alice, context: NullContext())

        _ = try bob.addPreKeys(50)
        _ = try bob.addPreKeys(50)
        let reopened = try store(db)
        let decrypted = try signalDecryptPreKey(
            message: PreKeySignalMessage(bytes: cipher.serialize()), from: ProtocolAddress(name: "alice", deviceId: 1),
            sessionStore: reopened, identityStore: reopened, preKeyStore: reopened, signedPreKeyStore: reopened,
            kyberPreKeyStore: reopened, context: NullContext())

        XCTAssertEqual(String(decoding: decrypted, as: UTF8.self), "delayed message")
    }

    // MARK: - Sessions

    func testAPreKeyMessageDecryptsAndItsSessionPersists() throws {
        let alice = try store(listing: ["bob": "bob-user"])
        try alice.install(SignalKeys.generate())
        let bob = try store(listing: ["alice": "alice-user"])
        let bobAddress = try ProtocolAddress(name: "bob", deviceId: 1)
        try processPreKeyBundle(bundle(installingIn: bob), for: bobAddress,
                                sessionStore: alice, identityStore: alice, context: NullContext())

        let cipher = try signalEncrypt(message: Array("test message".utf8), for: bobAddress,
                                       sessionStore: alice, identityStore: alice, context: NullContext())
        let decrypted = try signalDecryptPreKey(
            message: PreKeySignalMessage(bytes: cipher.serialize()), from: ProtocolAddress(name: "alice", deviceId: 1),
            sessionStore: bob, identityStore: bob, preKeyStore: bob, signedPreKeyStore: bob, kyberPreKeyStore: bob,
            context: NullContext())

        XCTAssertEqual(String(decoding: decrypted, as: UTF8.self), "test message")
        XCTAssertNotNil(try alice.loadSession(for: bobAddress, context: NullContext()))
        XCTAssertNil(try alice.loadSession(for: ProtocolAddress(name: "nobody", deviceId: 1), context: NullContext()))
    }
}
