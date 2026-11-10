import XCTest
import GRDB
import LibSignalClient
@testable import ObscuraKit

/// Pre-key generation, rotation and cleanup, as Signal-Android's `PreKeyUtil` and `PreKeysSyncJob` do it.
final class PreKeysTests: XCTestCase {
    private let day: Int64 = 24 * 60 * 60 * 1000
    private let plenty = PreKeyCounts(oneTime: 100, kyber: 100)
    private var db: DatabaseQueue!
    private var store: PersistentSignalStore!

    override func setUp() async throws {
        db = try ObscuraDatabase.inMemory()
        store = PersistentSignalStore(db: db, logger: SilentLogger())
    }

    @discardableResult
    private func provisioned(nowMs: Int64 = 0) throws -> ProvisioningKeys {
        let keys = try PreKeys.generateProvisioningKeys(nowMs: nowMs)
        try store.install(keys)
        return keys
    }

    private func state() throws -> PreKeyState { try XCTUnwrap(store.preKeyState()) }

    private func encodedKeys(_ upload: PreKeysUpload) throws -> Set<String> {
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(upload)) as? [String: Any]
        return Set(try XCTUnwrap(json).keys)
    }

    func testProvisioningSignsEveryPublishedKeyWithTheIdentity() throws {
        let keys = try PreKeys.generateProvisioningKeys(nowMs: 0)
        let identity = keys.identity.publicKey
        XCTAssertTrue(try identity.verifySignature(message: keys.signedPreKey.publicKey().serialize(), signature: keys.signedPreKey.signature))
        XCTAssertTrue(try identity.verifySignature(message: keys.lastResortKyberPreKey.publicKey().serialize(),
                                                   signature: keys.lastResortKyberPreKey.signature))
        for key in keys.kyberPreKeys {
            XCTAssertTrue(try identity.verifySignature(message: key.publicKey().serialize(), signature: key.signature))
        }
        XCTAssertEqual(keys.oneTimePreKeys.count, Int(PreKeys.batchSize))
        XCTAssertEqual(keys.kyberPreKeys.count, Int(PreKeys.batchSize))
        XCTAssertTrue((1...0x3FFF).contains(keys.registrationId), "the server accepts 1 through 16383")

        let request = try keys.accountRequest(username: "u", password: "p", name: "n")
        XCTAssertEqual(request.kyberPreKeys.count, Int(PreKeys.batchSize))
        XCTAssertEqual(request.lastResortKyberPreKey.keyId, Int(keys.lastResortKyberPreKey.id))
        XCTAssertEqual(try keys.deviceRequest(name: "n", linkSessionId: "s").oneTimePreKeys.count, Int(PreKeys.batchSize))
    }

    func testIdsStartAtRandomPointsAndKyberOneTimeIdsFollowTheLastResortIdOnOneCounter() throws {
        let a = try PreKeys.generateProvisioningKeys(nowMs: 0)
        let b = try PreKeys.generateProvisioningKeys(nowMs: 0)
        XCTAssertNotEqual([a.signedPreKey.id, a.oneTimePreKeys[0].id, a.lastResortKyberPreKey.id],
                          [b.signedPreKey.id, b.oneTimePreKeys[0].id, b.lastResortKyberPreKey.id])

        let lastResort = a.lastResortKyberPreKey.id
        let expected = (1...PreKeys.batchSize).map { (lastResort + $0) % PreKeys.maxId }
        XCTAssertEqual(a.kyberPreKeys.map(\.id), expected)
        XCTAssertEqual(a.state.nextKyberId, (expected.last! + 1) % PreKeys.maxId)
        XCTAssertEqual(a.state.activeSignedId, a.signedPreKey.id)
        XCTAssertEqual(a.state.activeLastResortId, lastResort)
    }

    func testNothingIsUploadedWhileTheServerHasEnoughKeysAndNothingIsDue() throws {
        try provisioned(nowMs: 0)
        let refill = try PreKeys.prepareRefill(store, counts: plenty, nowMs: day)
        XCTAssertTrue(refill.isEmpty)
        XCTAssertEqual(try encodedKeys(refill.upload()), [])
    }

    func testAKindTheServerHoldsFewerThan10OfIsRefilledWithANewBatch() throws {
        let keys = try provisioned()
        let nextOneTime = try state().nextOneTimeId

        let refill = try PreKeys.prepareRefill(store, counts: PreKeyCounts(oneTime: 9, kyber: 10), nowMs: day)

        XCTAssertEqual(refill.oneTimePreKeys.map(\.id), PreKeys.ids(from: nextOneTime, count: PreKeys.batchSize))
        XCTAssertTrue(refill.kyberPreKeys.isEmpty)
        XCTAssertNil(refill.signedPreKey)
        XCTAssertNil(refill.lastResortKyberPreKey)
        XCTAssertEqual(try encodedKeys(refill.upload()), ["oneTimePreKeys"])
        for key in refill.oneTimePreKeys { XCTAssertNotNil(try store.findPreKey(key.id)) }
        XCTAssertNotNil(try store.findPreKey(keys.oneTimePreKeys[0].id), "replaced keys stay for messages in flight")
        XCTAssertEqual(try state().nextOneTimeId, PreKeys.next(refill.oneTimePreKeys.last!.id))
    }

    func testAKyberRefillContinuesTheCounterTheLastResortKeyShares() throws {
        try provisioned()
        let nextKyber = try state().nextKyberId

        let refill = try PreKeys.prepareRefill(store, counts: PreKeyCounts(oneTime: 10, kyber: 0), nowMs: day)

        XCTAssertEqual(refill.kyberPreKeys.map(\.id), PreKeys.ids(from: nextKyber, count: PreKeys.batchSize))
        XCTAssertEqual(try store.kyberPreKeyCount(lastResort: true), 1)
        XCTAssertEqual(try store.kyberPreKeyCount(lastResort: false), 2 * Int(PreKeys.batchSize))
    }

    func testIdsWrapAtTheMaximum() throws {
        try provisioned()
        var wrapped = try state()
        wrapped.nextOneTimeId = PreKeys.maxId - 2
        try store.savePreKeyState(wrapped)

        let ids = try PreKeys.prepareRefill(store, counts: PreKeyCounts(oneTime: 0, kyber: 100), nowMs: day).oneTimePreKeys.map(\.id)

        XCTAssertEqual(Array(ids.prefix(4)), [PreKeys.maxId - 2, PreKeys.maxId - 1, 0, 1])
        XCTAssertEqual(try state().nextOneTimeId, PreKeys.batchSize - 2)
    }

    func testTheSignedAndLastResortKeysRotateEvery2DaysAndBecomeActiveOnceUploaded() throws {
        let keys = try provisioned(nowMs: 0)
        XCTAssertNil(try PreKeys.prepareRefill(store, counts: plenty, nowMs: PreKeys.refreshIntervalMs - 1).signedPreKey)

        let refill = try PreKeys.prepareRefill(store, counts: plenty, nowMs: PreKeys.refreshIntervalMs)
        let signed = try XCTUnwrap(refill.signedPreKey)
        let lastResort = try XCTUnwrap(refill.lastResortKyberPreKey)
        XCTAssertTrue(try keys.identity.publicKey.verifySignature(message: signed.publicKey().serialize(), signature: signed.signature))
        XCTAssertEqual(try state().activeSignedId, keys.signedPreKey.id, "not active until the server accepts it")
        XCTAssertEqual(try encodedKeys(refill.upload()), ["signedPreKey", "lastResortKyberPreKey"])

        try PreKeys.confirmRefill(store, refill, nowMs: PreKeys.refreshIntervalMs)

        XCTAssertEqual(try state().activeSignedId, signed.id)
        XCTAssertEqual(try state().activeLastResortId, lastResort.id)
        XCTAssertEqual(try state().signedRotatedAt, PreKeys.refreshIntervalMs)
        XCTAssertNotNil(try store.findSignedPreKey(keys.signedPreKey.id), "the previous key stays for messages in flight")
    }

    func testAClockSetBackRotatesRatherThanWaitingForItToCatchUp() throws {
        try provisioned(nowMs: 10 * day)
        let refill = try PreKeys.prepareRefill(store, counts: plenty, nowMs: day)
        XCTAssertNotNil(refill.signedPreKey)
        XCTAssertNotNil(refill.lastResortKyberPreKey)
    }

    func testASyncIsDueOnceTheLastOneIs2DaysOldAndNeverBeforeProvisioning() throws {
        XCTAssertFalse(try PreKeys.isSyncDue(store, nowMs: 0))
        try provisioned(nowMs: 0)
        XCTAssertFalse(try PreKeys.isSyncDue(store, nowMs: PreKeys.refreshIntervalMs - 1))
        XCTAssertTrue(try PreKeys.isSyncDue(store, nowMs: PreKeys.refreshIntervalMs))

        let refill = try PreKeys.prepareRefill(store, counts: plenty, nowMs: PreKeys.refreshIntervalMs)
        try PreKeys.confirmRefill(store, refill, nowMs: PreKeys.refreshIntervalMs)
        XCTAssertFalse(try PreKeys.isSyncDue(store, nowMs: PreKeys.refreshIntervalMs + 1))
    }

    func testAfterAFailedUploadTheNextSyncUploadsTheSameKeysInsteadOfStoringMore() throws {
        try provisioned(nowMs: 0)
        let now = PreKeys.refreshIntervalMs
        let low = PreKeyCounts(oneTime: 0, kyber: 0)
        let first = try PreKeys.prepareRefill(store, counts: low, nowMs: now)
        let stored = {
            [try self.store.signedPreKeyIds().count, try self.store.oneTimePreKeyCount(),
             try self.store.kyberPreKeyCount(lastResort: false), try self.store.kyberPreKeyCount(lastResort: true)]
        }
        let afterFirst = try stored()

        // The upload failed, so nothing was confirmed; each retry must not add keys.
        for retry in 0..<3 {
            let again = try PreKeys.prepareRefill(store, counts: low, nowMs: now + Int64(retry))
            XCTAssertEqual(again.signedPreKey?.id, first.signedPreKey?.id)
            XCTAssertEqual(again.lastResortKyberPreKey?.id, first.lastResortKyberPreKey?.id)
            XCTAssertEqual(again.oneTimePreKeys.map(\.id), first.oneTimePreKeys.map(\.id))
            XCTAssertEqual(again.kyberPreKeys.map(\.id), first.kyberPreKeys.map(\.id))
        }
        XCTAssertEqual(try stored(), afterFirst)

        try PreKeys.confirmRefill(store, first, nowMs: now)
        let confirmed = try state()
        XCTAssertNil(confirmed.pendingSignedId)
        XCTAssertNil(confirmed.pendingLastResortId)
        XCTAssertNil(confirmed.pendingOneTimeStart)
        XCTAssertNil(confirmed.pendingKyberStart)
        XCTAssertTrue(try PreKeys.prepareRefill(store, counts: plenty, nowMs: now).isEmpty)
    }

    func testAPendingBatchTheServerNoLongerNeedsIsDroppedAndALaterRefillGeneratesNewKeys() throws {
        try provisioned()
        let lowOneTime = PreKeyCounts(oneTime: 0, kyber: 100)
        let pending = try PreKeys.prepareRefill(store, counts: lowOneTime, nowMs: day)
        XCTAssertTrue(try PreKeys.prepareRefill(store, counts: plenty, nowMs: day).isEmpty, "counts recovered: the batch reached the server")
        XCTAssertNil(try state().pendingOneTimeStart)

        let next = try PreKeys.prepareRefill(store, counts: lowOneTime, nowMs: 2 * day)
        XCTAssertEqual(next.oneTimePreKeys.first?.id, PreKeys.next(pending.oneTimePreKeys.last!.id))
    }

    func testRefillingNeedsProvisionedKeys() throws {
        let empty = PersistentSignalStore(db: try ObscuraDatabase.inMemory(), logger: SilentLogger())
        XCTAssertThrowsError(try PreKeys.prepareRefill(empty, counts: plenty, nowMs: day))
        XCTAssertThrowsError(try PreKeys.confirmRefill(empty, PreKeyRefill(signedPreKey: nil, lastResortKyberPreKey: nil,
                                                                           oneTimePreKeys: [], kyberPreKeys: []), nowMs: day))
    }

    func testReplacedSignedKeysOlderThan30DaysGoExceptTheYoungestOfThem() throws {
        let keys = try provisioned(nowMs: 0)
        var rotations: [UInt32] = []
        for n in Int64(1)...3 {
            let now = n * 10 * day
            let refill = try PreKeys.prepareRefill(store, counts: plenty, nowMs: now)
            try PreKeys.confirmRefill(store, refill, nowMs: now)
            rotations.append(try XCTUnwrap(refill.signedPreKey).id)
        }
        // At day 30 the original key (day 0) and the first rotation (day 10) are not older than 30 days yet.
        XCTAssertNotNil(try store.findSignedPreKey(keys.signedPreKey.id))

        try store.cleanPreKeys(nowMs: 45 * day)

        XCTAssertNil(try store.findSignedPreKey(keys.signedPreKey.id), "older than 30 days, and not the youngest such")
        XCTAssertNotNil(try store.findSignedPreKey(rotations[0]), "the youngest key older than 30 days stays")
        XCTAssertNotNil(try store.findSignedPreKey(rotations[1]))
        XCTAssertNotNil(try store.findSignedPreKey(rotations[2]), "the active key always stays")
        XCTAssertNil(try store.findKyberPreKey(keys.lastResortKyberPreKey.id), "last-resort keys are cleaned the same way")
    }

    func testStaleOneTimeKeysGoAfter90DaysKeepingAtLeast200() throws {
        let keys = try provisioned(nowMs: 0)
        for _ in 0..<3 {
            let refill = try PreKeys.prepareRefill(store, counts: PreKeyCounts(oneTime: 0, kyber: 0), nowMs: day)
            try PreKeys.confirmRefill(store, refill, nowMs: day)
        }
        // 400 EC keys: the provisioned batch and two uploaded refills are stale since day 1, the last batch is fresh.

        try store.cleanPreKeys(nowMs: day + 90 * day - 1)
        XCTAssertNotNil(try store.findPreKey(keys.oneTimePreKeys[0].id), "not yet stale for 90 days")

        try store.cleanPreKeys(nowMs: 2 * day + 90 * day)
        XCTAssertEqual(try store.oneTimePreKeyCount(), PersistentSignalStore.minOneTimeKept)
        XCTAssertEqual(try store.kyberPreKeyCount(lastResort: false), PersistentSignalStore.minOneTimeKept)
        XCTAssertNil(try store.findPreKey(keys.oneTimePreKeys[0].id))
    }

    func testAMessageFromAnEarlierBundleDecryptsAfterRotation() throws {
        let receiverDb = try ObscuraDatabase.inMemory()
        try receiverDb.write { db in
            try DeviceStore.setLocalDevice("receiver", primaryDeviceId: "receiver", in: db)
            try DeviceStore.add(userId: "sender-user", deviceId: "sender", in: db)
        }
        let receiver = PersistentSignalStore(db: receiverDb, logger: SilentLogger())
        let keys = try PreKeys.generateProvisioningKeys(nowMs: 0)
        try receiver.install(keys)
        let senderDb = try ObscuraDatabase.inMemory()
        try senderDb.write { db in
            try DeviceStore.setLocalDevice("sender", primaryDeviceId: "sender", in: db)
            try DeviceStore.add(userId: "receiver-user", deviceId: "receiver", in: db)
        }
        let sender = PersistentSignalStore(db: senderDb, logger: SilentLogger())
        try sender.install(provisioningKeys())
        let response = PreKeyBundleResponse(
            deviceId: UUID().uuidString.lowercased(), registrationId: Int(keys.registrationId),
            identityKey: Data(keys.identity.publicKey.serialize()).base64EncodedString(),
            signedPreKey: .init(keyId: Int(keys.signedPreKey.id), publicKey: Data(try keys.signedPreKey.publicKey().serialize()).base64EncodedString(),
                                signature: Data(keys.signedPreKey.signature).base64EncodedString()),
            kyberPreKey: .init(keyId: Int(keys.kyberPreKeys[0].id), publicKey: Data(try keys.kyberPreKeys[0].publicKey().serialize()).base64EncodedString(),
                               signature: Data(keys.kyberPreKeys[0].signature).base64EncodedString()),
            oneTimePreKey: .init(keyId: Int(keys.oneTimePreKeys[0].id),
                                 publicKey: Data(try keys.oneTimePreKeys[0].publicKey().serialize()).base64EncodedString()))
        let bundle = try XCTUnwrap(Messenger.verifiedBundles([response]).first).bundle
        let receiverAddress = try Messenger.address("receiver")
        let senderAddress = try Messenger.address("sender")
        try processPreKeyBundle(bundle, for: receiverAddress, ourAddress: senderAddress,
                                sessionStore: sender, identityStore: sender, context: NullContext())
        let cipher = try signalEncrypt(message: Array("hello".utf8), for: receiverAddress, localAddress: senderAddress,
                                       sessionStore: sender, identityStore: sender, context: NullContext())

        // Rotation before the message arrives must not strand it.
        let refill = try PreKeys.prepareRefill(receiver, counts: PreKeyCounts(oneTime: 0, kyber: 0), nowMs: PreKeys.refreshIntervalMs)
        try PreKeys.confirmRefill(receiver, refill, nowMs: PreKeys.refreshIntervalMs)

        let plaintext = try signalDecryptPreKey(
            message: PreKeySignalMessage(bytes: cipher.serialize()), from: senderAddress, localAddress: receiverAddress,
            sessionStore: receiver, identityStore: receiver, preKeyStore: receiver, signedPreKeyStore: receiver,
            kyberPreKeyStore: receiver, context: NullContext())
        XCTAssertEqual(String(decoding: plaintext, as: UTF8.self), "hello")
        XCTAssertNil(try receiver.findPreKey(keys.oneTimePreKeys[0].id))
        XCTAssertNil(try receiver.findKyberPreKey(keys.kyberPreKeys[0].id))
        XCTAssertNotNil(try receiver.findKyberPreKey(keys.lastResortKyberPreKey.id))
    }
}
