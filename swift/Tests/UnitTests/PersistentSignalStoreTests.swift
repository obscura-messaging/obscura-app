import XCTest
import GRDB
import LibSignalClient
@testable import ObscuraKit

final class PersistentSignalStoreTests: XCTestCase {
    private let aliceAddress = try! ProtocolAddress(name: "alice", deviceId: 1)
    private let bobAddress = try! ProtocolAddress(name: "bob", deviceId: 1)

    private func store(_ db: DatabaseQueue? = nil, listing devices: [String: String] = [:],
                       logger: ObscuraLogger = SilentLogger()) throws -> PersistentSignalStore {
        let db = try db ?? ObscuraDatabase.inMemory()
        try db.write { db in
            for (deviceId, userId) in devices { try DeviceStore.add(userId: userId, deviceId: deviceId, in: db) }
        }
        return PersistentSignalStore(db: db, logger: logger)
    }

    /// Installs fresh keys in `peer` and returns a PQXDH bundle for them using its first one-time keys,
    /// or its last-resort Kyber key.
    private func bundle(installingIn peer: PersistentSignalStore, identity: IdentityKeyPair = .generate(),
                        lastResort: Bool = false) throws -> PreKeyBundle {
        let keys = try provisioningKeys(identity: identity)
        try peer.install(keys)
        let kyber = lastResort ? keys.lastResortKyberPreKey : keys.kyberPreKeys[0]
        return try PreKeyBundle(
            registrationId: keys.registrationId, deviceId: 1, prekeyId: keys.oneTimePreKeys[0].id,
            prekey: keys.oneTimePreKeys[0].publicKey(), signedPrekeyId: keys.signedPreKey.id,
            signedPrekey: keys.signedPreKey.publicKey(), signedPrekeySignature: keys.signedPreKey.signature,
            identity: keys.identity.identityKey, kyberPrekeyId: kyber.id, kyberPrekey: kyber.publicKey(),
            kyberPrekeySignature: kyber.signature)
    }

    /// `sender` starts a session with `receiver`'s device "bob" and encrypts `text` as a pre-key message.
    private func preKeyMessage(_ text: String, from sender: PersistentSignalStore, bundle: PreKeyBundle) throws -> PreKeySignalMessage {
        try processPreKeyBundle(bundle, for: bobAddress, ourAddress: aliceAddress,
                                sessionStore: sender, identityStore: sender, context: NullContext())
        let cipher = try signalEncrypt(message: Array(text.utf8), for: bobAddress, localAddress: aliceAddress,
                                       sessionStore: sender, identityStore: sender, context: NullContext())
        return try PreKeySignalMessage(bytes: cipher.serialize())
    }

    private func decrypt(_ message: PreKeySignalMessage, by receiver: PersistentSignalStore) throws -> String {
        String(decoding: try signalDecryptPreKey(
            message: message, from: aliceAddress, localAddress: bobAddress,
            sessionStore: receiver, identityStore: receiver, preKeyStore: receiver, signedPreKeyStore: receiver,
            kyberPreKeyStore: receiver, context: NullContext()), as: UTF8.self)
    }

    // MARK: - Identity

    func testInstallPersistsTheIdentityAndEveryKeyAcrossStores() throws {
        let db = try ObscuraDatabase.inMemory()
        let first = try store(db)
        XCTAssertFalse(try first.hasIdentity())
        let keys = try provisioningKeys()

        try first.install(keys)

        let reopened = try store(db)
        XCTAssertTrue(try reopened.hasIdentity())
        XCTAssertEqual(try reopened.identityKeyPair(context: NullContext()).serialize(), keys.identity.serialize())
        XCTAssertEqual(try reopened.localRegistrationId(context: NullContext()), keys.registrationId)
        XCTAssertEqual(try reopened.oneTimePreKeyCount(), Int(PreKeys.batchSize))
        XCTAssertEqual(try reopened.kyberPreKeyCount(lastResort: false), Int(PreKeys.batchSize))
        XCTAssertEqual(try reopened.lastResortKyberPreKeyIds(), [keys.lastResortKyberPreKey.id])
        XCTAssertEqual(try reopened.loadSignedPreKey(id: keys.signedPreKey.id, context: NullContext()).serialize(),
                       keys.signedPreKey.serialize())
        XCTAssertEqual(try reopened.preKeyState(), keys.state)
    }

    func testInstallReplacesEveryEarlierRecord() throws {
        let store = try store(listing: ["bob": "bob-user"])
        try store.install(provisioningKeys())
        _ = try preKeyMessage("hi", from: store, bundle: bundle(installingIn: try self.store()))
        XCTAssertNotNil(try store.loadSession(for: bobAddress, context: NullContext()))

        let replacement = try provisioningKeys()
        try store.install(replacement)

        XCTAssertEqual(try store.identityKeyPair(context: NullContext()).serialize(), replacement.identity.serialize())
        XCTAssertNil(try store.loadSession(for: bobAddress, context: NullContext()))
        XCTAssertNil(try store.identity(for: bobAddress, context: NullContext()))
        XCTAssertEqual(try store.preKeyState(), replacement.state)
    }

    func testAMissingIdentityOrLocalDeviceThrows() throws {
        let store = try store()
        XCTAssertThrowsError(try store.identityKeyPair(context: NullContext()))
        XCTAssertThrowsError(try store.localRegistrationId(context: NullContext()))
        XCTAssertThrowsError(try store.localAddress())
        XCTAssertNil(try store.preKeyState())
    }

    func testTheLocalAddressIsTheLocalDevice() throws {
        let db = try ObscuraDatabase.inMemory()
        try db.write { try DeviceStore.setLocalDevice("me", primaryDeviceId: "me", in: $0) }
        XCTAssertEqual(try store(db).localAddress(), try Messenger.address("me"))
    }

    // MARK: - Identity trust (per account, Signal's policy for unverified contacts)

    func testTheFirstIdentityOfAnAccountIsTrustedAndSharedByItsDevices() throws {
        let logger = RecordingLogger(SilentLogger())
        let store = try store(listing: ["phone": "alice", "laptop": "alice"], logger: logger)
        let identity = IdentityKey(publicKey: PrivateKey.generate().publicKey)
        let phone = try ProtocolAddress(name: "phone", deviceId: 1)
        let laptop = try ProtocolAddress(name: "laptop", deviceId: 1)

        XCTAssertTrue(try store.isTrustedIdentity(identity, for: phone, direction: .receiving, context: NullContext()))
        XCTAssertEqual(try store.saveIdentity(identity, for: phone, context: NullContext()), .newOrUnchanged,
                       "the first key is not a change")
        XCTAssertEqual(try store.saveIdentity(identity, for: laptop, context: NullContext()), .newOrUnchanged,
                       "a linked device shares it")
        XCTAssertEqual(try store.identity(for: laptop, context: NullContext()), identity)
        XCTAssertTrue(logger.snapshot().isEmpty)
    }

    func testADifferentIdentityIsAcceptedForTheWholeAccountDroppingItsSessionsAndLogged() throws {
        let logger = RecordingLogger(SilentLogger())
        let store = try store(listing: ["phone": "alice", "laptop": "alice", "bob-phone": "bob"], logger: logger)
        try store.install(provisioningKeys())
        let alice = IdentityKeyPair.generate()
        for (name, identity) in [("phone", alice), ("laptop", alice), ("bob-phone", IdentityKeyPair.generate())] {
            try processPreKeyBundle(bundle(installingIn: try self.store(), identity: identity),
                                    for: ProtocolAddress(name: name, deviceId: 1), ourAddress: aliceAddress,
                                    sessionStore: store, identityStore: store, context: NullContext())
        }
        XCTAssertTrue(logger.snapshot().isEmpty, "devices of one account share its identity")
        let replacement = IdentityKey(publicKey: PrivateKey.generate().publicKey)
        let phone = try ProtocolAddress(name: "phone", deviceId: 1)

        XCTAssertTrue(try store.isTrustedIdentity(replacement, for: phone, direction: .sending, context: NullContext()))
        XCTAssertEqual(try store.saveIdentity(replacement, for: phone, context: NullContext()), .replacedExisting)

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
        let keys = try provisioningKeys()
        try store.install(keys)
        let id = keys.oneTimePreKeys[7].id

        XCTAssertNoThrow(try store.loadPreKey(id: id, context: NullContext()))
        try store.removePreKey(id: id, context: NullContext())

        XCTAssertThrowsError(try store.loadPreKey(id: id, context: NullContext()))
        XCTAssertNil(try store.findPreKey(id))
        XCTAssertThrowsError(try store.loadSignedPreKey(id: keys.signedPreKey.id &+ 1, context: NullContext()))
        XCTAssertThrowsError(try store.loadKyberPreKey(id: keys.lastResortKyberPreKey.id &+ 200, context: NullContext()))
        XCTAssertEqual(try store.oneTimePreKeyCount(), Int(PreKeys.batchSize) - 1)
    }

    func testAPQXDHSessionUsesUpBothOneTimeKeysAndPersists() throws {
        let alice = try store(listing: ["bob": "bob-user"])
        try alice.install(provisioningKeys())
        let bob = try store(listing: ["alice": "alice-user"])
        let bundle = try bundle(installingIn: bob)

        let message = try preKeyMessage("test message", from: alice, bundle: bundle)
        XCTAssertEqual(try decrypt(message, by: bob), "test message")

        XCTAssertNil(try bob.findPreKey(try XCTUnwrap(bundle.preKeyId)))
        XCTAssertNil(try bob.findKyberPreKey(bundle.kyberPreKeyId), "a one-time Kyber key is used once")
        XCTAssertEqual(try bob.kyberPreKeyCount(lastResort: true), 1)
        XCTAssertNotNil(try alice.loadSession(for: bobAddress, context: NullContext()))
        XCTAssertNil(try alice.loadSession(for: ProtocolAddress(name: "nobody", deviceId: 1), context: NullContext()))
    }

    func testALastResortKyberKeyStaysButAReplayedFirstMessageIsRejected() throws {
        let alice = try store(listing: ["bob": "bob-user"])
        try alice.install(provisioningKeys())
        let db = try ObscuraDatabase.inMemory()
        let bob = try store(db, listing: ["alice": "alice-user"])
        let bundle = try bundle(installingIn: bob, lastResort: true)
        let message = try preKeyMessage("first", from: alice, bundle: bundle)
        let snapshot = try db.read { db in try Data.fetchAll(db, sql: "SELECT record FROM signal_prekeys") }

        XCTAssertEqual(try decrypt(message, by: bob), "first")
        XCTAssertNotNil(try bob.findKyberPreKey(bundle.kyberPreKeyId), "the last-resort key serves every session")

        // Replaying the first message once its session is gone: the one-time EC key is restored so only
        // the Kyber use record can catch it.
        try db.write { db in
            try db.execute(sql: "DELETE FROM signal_sessions")
            for record in snapshot {
                let key = try PreKeyRecord(bytes: record)
                try db.execute(sql: "INSERT OR REPLACE INTO signal_prekeys (key_id, record) VALUES (?, ?)", arguments: [key.id, record])
            }
        }
        XCTAssertThrowsError(try decrypt(message, by: bob))
    }

    func testKyberKeysStoredThroughTheProtocolAreOneTimeKeys() throws {
        let store = try store()
        let keys = try provisioningKeys()
        try store.install(keys)
        try store.storeKyberPreKey(keys.kyberPreKeys[0], id: 4242, context: NullContext())
        XCTAssertEqual(try store.loadKyberPreKey(id: 4242, context: NullContext()).serialize(), keys.kyberPreKeys[0].serialize())
        try store.markKyberPreKeyUsed(id: 4242, signedPreKeyId: keys.signedPreKey.id, baseKey: PrivateKey.generate().publicKey,
                                      context: NullContext())
        XCTAssertNil(try store.findKyberPreKey(4242))
        // An unknown id has nothing to delete or record.
        XCTAssertNoThrow(try store.markKyberPreKeyUsed(id: 4243, signedPreKeyId: 1, baseKey: PrivateKey.generate().publicKey,
                                                       context: NullContext()))
    }

    func testStorePreKeySignedPreKeyAndLoadExistingSessions() throws {
        let store = try store()
        let keys = try provisioningKeys()
        try store.install(keys)
        try store.storePreKey(keys.oneTimePreKeys[0], id: 999, context: NullContext())
        XCTAssertNoThrow(try store.loadPreKey(id: 999, context: NullContext()))
        try store.storeSignedPreKey(keys.signedPreKey, id: 888, context: NullContext())
        XCTAssertNoThrow(try store.loadSignedPreKey(id: 888, context: NullContext()))
        let existingSessions = try store.loadExistingSessions(
            for: [ProtocolAddress(name: "missing", deviceId: 1)], context: NullContext()
        )
        XCTAssertTrue(existingSessions.isEmpty)
    }
}
