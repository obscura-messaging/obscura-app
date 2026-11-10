import Foundation
import GRDB
import LibSignalClient

/// Which keys this device has published, the next id of each kind, and when it last rotated and
/// synced them, like Signal-Android's `PreKeyMetadataStore`. The pending ids name keys stored for an
/// upload the server has not yet accepted: the signed and last-resort keys, and the first id of each
/// one-time batch.
struct PreKeyState: Equatable, Sendable {
    var nextSignedId: UInt32
    var nextOneTimeId: UInt32
    var nextKyberId: UInt32
    var activeSignedId: UInt32?
    var activeLastResortId: UInt32?
    var signedRotatedAt: Int64
    var lastResortRotatedAt: Int64
    var syncedAt: Int64
    var pendingSignedId: UInt32? = nil
    var pendingLastResortId: UInt32? = nil
    var pendingOneTimeStart: UInt32? = nil
    var pendingKyberStart: UInt32? = nil
}

extension PreKeyState {
    init(row: Row) {
        self.init(
            nextSignedId: row["next_signed_id"], nextOneTimeId: row["next_one_time_id"], nextKyberId: row["next_kyber_id"],
            activeSignedId: row["active_signed_id"], activeLastResortId: row["active_last_resort_id"],
            signedRotatedAt: row["signed_rotated_at"], lastResortRotatedAt: row["last_resort_rotated_at"],
            syncedAt: row["synced_at"], pendingSignedId: row["pending_signed_id"],
            pendingLastResortId: row["pending_last_resort_id"], pendingOneTimeStart: row["pending_one_time_start"],
            pendingKyberStart: row["pending_kyber_start"])
    }
}

/// A new device's keys: the account identity (new for a primary, received for a linked device), its
/// own registration id, signed and last-resort pre-keys and a batch of each kind of one-time key, held
/// in memory until the server has accepted the device.
struct ProvisioningKeys {
    let identity: IdentityKeyPair
    let registrationId: UInt32
    let signedPreKey: SignedPreKeyRecord
    let lastResortKyberPreKey: KyberPreKeyRecord
    let oneTimePreKeys: [PreKeyRecord]
    let kyberPreKeys: [KyberPreKeyRecord]
    /// The bookkeeping to store once the server has accepted these keys.
    let state: PreKeyState

    func accountRequest(username: String, password: String, name: String) throws -> AccountProvisionRequest {
        AccountProvisionRequest(
            username: username, password: password, name: name,
            identityKey: Data(identity.publicKey.serialize()).base64EncodedString(),
            registrationId: Int(registrationId), signedPreKey: try signedPreKey.upload(),
            lastResortKyberPreKey: try lastResortKyberPreKey.upload(),
            oneTimePreKeys: try oneTimePreKeys.map { try $0.upload() }, kyberPreKeys: try kyberPreKeys.map { try $0.upload() })
    }

    func deviceRequest(name: String, linkSessionId: String) throws -> CreateDeviceRequest {
        CreateDeviceRequest(
            linkSessionId: linkSessionId, name: name,
            identityKey: Data(identity.publicKey.serialize()).base64EncodedString(),
            registrationId: Int(registrationId), signedPreKey: try signedPreKey.upload(),
            lastResortKyberPreKey: try lastResortKyberPreKey.upload(),
            oneTimePreKeys: try oneTimePreKeys.map { try $0.upload() }, kyberPreKeys: try kyberPreKeys.map { try $0.upload() })
    }
}

/// The keys a sync generated and stored; what is absent is left as it is on the server. libsignal's
/// records are immutable once built, so the refill can leave the task that generated it.
struct PreKeyRefill: @unchecked Sendable {
    let signedPreKey: SignedPreKeyRecord?
    let lastResortKyberPreKey: KyberPreKeyRecord?
    let oneTimePreKeys: [PreKeyRecord]
    let kyberPreKeys: [KyberPreKeyRecord]

    var isEmpty: Bool {
        signedPreKey == nil && lastResortKyberPreKey == nil && oneTimePreKeys.isEmpty && kyberPreKeys.isEmpty
    }

    func upload() throws -> PreKeysUpload {
        PreKeysUpload(signedPreKey: try signedPreKey?.upload(), lastResortKyberPreKey: try lastResortKyberPreKey?.upload(),
                      oneTimePreKeys: try oneTimePreKeys.map { try $0.upload() }, kyberPreKeys: try kyberPreKeys.map { try $0.upload() })
    }
}

/// Pre-key generation and rotation, following Signal-Android's `PreKeyUtil` and `PreKeysSyncJob`: ids
/// start at a random point and wrap at `maxId`; one-time keys come in batches of `batchSize` and are
/// refilled when the server holds fewer than `oneTimeMinimum`; the signed and last-resort keys rotate
/// every `refreshIntervalMs`. One-time and last-resort Kyber keys share one id counter, since libsignal
/// looks both up by id in one store.
enum PreKeys {
    static let batchSize: UInt32 = 100
    static let oneTimeMinimum = 10
    static let refreshIntervalMs: Int64 = 2 * 24 * 60 * 60 * 1000
    /// Bundle fetches use keys up with no message to signal it, so a signed-in client checks this often too.
    static let checkIntervalMs: UInt64 = 6 * 60 * 60 * 1000
    /// The least time between syncs, so a backlog of pre-key messages costs one or two checks.
    static let syncSpacingMs: UInt64 = 30 * 1000
    /// libsignal's `Medium.MAX_VALUE`: key ids are 24-bit on the wire.
    static let maxId: UInt32 = 0xFFFFFF

    /// A registration id, signed and last-resort pre-keys and a batch of each kind of one-time key, signed
    /// by `identity`: a new identity for a primary, the account identity for a linked device.
    static func generateProvisioningKeys(identity: IdentityKeyPair = .generate(), nowMs: Int64) throws -> ProvisioningKeys {
        let signedId = UInt32.random(in: 0..<maxId)
        let oneTimeStart = UInt32.random(in: 0..<maxId)
        let lastResortId = UInt32.random(in: 0..<maxId)
        let kyberIds = ids(from: next(lastResortId), count: batchSize)
        let oneTimeIds = ids(from: oneTimeStart, count: batchSize)
        return ProvisioningKeys(
            identity: identity,
            registrationId: UInt32.random(in: 1...16380),
            signedPreKey: try signedPreKey(identity, id: signedId, nowMs: nowMs),
            lastResortKyberPreKey: try kyberPreKey(identity, id: lastResortId, nowMs: nowMs),
            oneTimePreKeys: try oneTimeIds.map { try PreKeyRecord(id: $0, privateKey: PrivateKey.generate()) },
            kyberPreKeys: try kyberIds.map { try kyberPreKey(identity, id: $0, nowMs: nowMs) },
            state: PreKeyState(
                nextSignedId: next(signedId), nextOneTimeId: next(oneTimeIds.last!), nextKyberId: next(kyberIds.last!),
                activeSignedId: signedId, activeLastResortId: lastResortId,
                signedRotatedAt: nowMs, lastResortRotatedAt: nowMs, syncedAt: nowMs))
    }

    /// Whether a sync is due without a reason from the server: nothing published yet, or the last one is old.
    static func isSyncDue(_ store: PersistentSignalStore, nowMs: Int64) throws -> Bool {
        guard let state = try store.preKeyState() else { return false }
        return state.activeSignedId == nil || state.activeLastResortId == nil || isDue(since: state.syncedAt, nowMs: nowMs)
    }

    /// Generates and stores what the server needs given its `counts`: new one-time keys of a kind it is
    /// short of, and a new signed or last-resort key once the current one is due for rotation. Earlier
    /// one-time keys of a refilled kind are marked stale, since the upload replaces them.
    ///
    /// Keys stored for an earlier upload that never succeeded are uploaded again instead of new ones, so a
    /// server that keeps failing doesn't pile up keys. Generation runs before the write: a batch of
    /// Kyber-1024 keys takes a while, and holding the database would stall receive.
    static func prepareRefill(_ store: PersistentSignalStore, counts: OneTimePreKeyCounts, nowMs: Int64) throws -> PreKeyRefill {
        guard let state = try store.preKeyState() else { throw ObscuraError.storageFailed("pre-keys not provisioned") }
        let identity = try store.identityKeyPair(context: NullContext())
        let signedDue = state.activeSignedId == nil || isDue(since: state.signedRotatedAt, nowMs: nowMs)
        let lastResortDue = state.activeLastResortId == nil || isDue(since: state.lastResortRotatedAt, nowMs: nowMs)
        let oneTimeLow = counts.oneTime < oneTimeMinimum
        let kyberLow = counts.kyber < oneTimeMinimum

        let pendingSigned = try signedDue ? state.pendingSignedId.flatMap(store.findSignedPreKey) : nil
        let pendingLastResort = try lastResortDue ? state.pendingLastResortId.flatMap(store.findKyberPreKey) : nil
        // A batch the server took and peers drew on still has the keys not yet used; counts back above
        // the minimum mean it, or an older batch, is serving and nothing is pending.
        let pendingOneTime = try oneTimeLow
            ? state.pendingOneTimeStart.map { try ids(from: $0, count: batchSize).compactMap(store.findPreKey) } ?? [] : []
        let pendingKyber = try kyberLow
            ? state.pendingKyberStart.map { try ids(from: $0, count: batchSize).compactMap(store.findKyberPreKey) } ?? [] : []

        var updated = state
        if !oneTimeLow { updated.pendingOneTimeStart = nil }
        if !kyberLow { updated.pendingKyberStart = nil }
        var newSigned: SignedPreKeyRecord?
        if signedDue && pendingSigned == nil {
            let key = try signedPreKey(identity, id: updated.nextSignedId, nowMs: nowMs)
            updated.nextSignedId = next(key.id)
            updated.pendingSignedId = key.id
            newSigned = key
        }
        var newLastResort: KyberPreKeyRecord?
        if lastResortDue && pendingLastResort == nil {
            let key = try kyberPreKey(identity, id: updated.nextKyberId, nowMs: nowMs)
            updated.nextKyberId = next(key.id)
            updated.pendingLastResortId = key.id
            newLastResort = key
        }
        var newOneTime: [PreKeyRecord] = []
        if oneTimeLow && pendingOneTime.isEmpty {
            let batch = ids(from: updated.nextOneTimeId, count: batchSize)
            newOneTime = try batch.map { try PreKeyRecord(id: $0, privateKey: PrivateKey.generate()) }
            updated.nextOneTimeId = next(batch.last!)
            updated.pendingOneTimeStart = batch.first
        }
        var newKyber: [KyberPreKeyRecord] = []
        if kyberLow && pendingKyber.isEmpty {
            let batch = ids(from: updated.nextKyberId, count: batchSize)
            newKyber = try batch.map { try kyberPreKey(identity, id: $0, nowMs: nowMs) }
            updated.nextKyberId = next(batch.last!)
            updated.pendingKyberStart = batch.first
        }

        try store.transaction { db, _ in
            guard try PersistentSignalStore.preKeyState(in: db) == state else {
                throw ObscuraError.storageFailed("pre-key state changed during a sync")
            }
            if let newSigned { try PersistentSignalStore.storeSignedPreKey(newSigned, in: db) }
            if let newLastResort { try PersistentSignalStore.storeKyberPreKey(newLastResort, lastResort: true, in: db) }
            if !newOneTime.isEmpty {
                try PersistentSignalStore.markOneTimePreKeysStale(kyber: false, nowMs: nowMs, in: db)
                for key in newOneTime { try PersistentSignalStore.storePreKey(key, in: db) }
            }
            if !newKyber.isEmpty {
                try PersistentSignalStore.markOneTimePreKeysStale(kyber: true, nowMs: nowMs, in: db)
                for key in newKyber { try PersistentSignalStore.storeKyberPreKey(key, lastResort: false, in: db) }
            }
            try PersistentSignalStore.savePreKeyState(updated, in: db)
        }
        return PreKeyRefill(
            signedPreKey: newSigned ?? pendingSigned,
            lastResortKyberPreKey: newLastResort ?? pendingLastResort,
            oneTimePreKeys: newOneTime.isEmpty ? pendingOneTime : newOneTime,
            kyberPreKeys: newKyber.isEmpty ? pendingKyber : newKyber)
    }

    /// After the server accepted `refill` (or nothing needed uploading): the new keys are the active ones.
    static func confirmRefill(_ store: PersistentSignalStore, _ refill: PreKeyRefill, nowMs: Int64) throws {
        try store.transaction { db, _ in
            guard var state = try PersistentSignalStore.preKeyState(in: db) else {
                throw ObscuraError.storageFailed("pre-keys not provisioned")
            }
            if let signed = refill.signedPreKey {
                state.activeSignedId = signed.id
                state.signedRotatedAt = nowMs
                state.pendingSignedId = nil
            }
            if let lastResort = refill.lastResortKyberPreKey {
                state.activeLastResortId = lastResort.id
                state.lastResortRotatedAt = nowMs
                state.pendingLastResortId = nil
            }
            if !refill.oneTimePreKeys.isEmpty { state.pendingOneTimeStart = nil }
            if !refill.kyberPreKeys.isEmpty { state.pendingKyberStart = nil }
            state.syncedAt = nowMs
            try PersistentSignalStore.savePreKeyState(state, in: db)
            try PersistentSignalStore.cleanPreKeys(nowMs: nowMs, in: db)
        }
    }

    /// A clock set back makes the elapsed time negative; rotate rather than wait for it to catch up.
    private static func isDue(since: Int64, nowMs: Int64) -> Bool {
        nowMs - since >= refreshIntervalMs || nowMs < since
    }

    static func next(_ id: UInt32) -> UInt32 { (id + 1) % maxId }

    static func ids(from start: UInt32, count: UInt32) -> [UInt32] {
        (0..<count).map { (start + $0) % maxId }
    }

    private static func signedPreKey(_ identity: IdentityKeyPair, id: UInt32, nowMs: Int64) throws -> SignedPreKeyRecord {
        let privateKey = PrivateKey.generate()
        return try SignedPreKeyRecord(id: id, timestamp: UInt64(nowMs), privateKey: privateKey,
                                      signature: identity.privateKey.generateSignature(message: privateKey.publicKey.serialize()))
    }

    private static func kyberPreKey(_ identity: IdentityKeyPair, id: UInt32, nowMs: Int64) throws -> KyberPreKeyRecord {
        let keyPair = KEMKeyPair.generate()
        return try KyberPreKeyRecord(id: id, timestamp: UInt64(nowMs), keyPair: keyPair,
                                     signature: identity.privateKey.generateSignature(message: keyPair.publicKey.serialize()))
    }
}

extension SignedPreKeyRecord {
    func upload() throws -> SignedPreKeyUpload {
        SignedPreKeyUpload(keyId: Int(id), publicKey: Data(try publicKey().serialize()).base64EncodedString(),
                           signature: Data(signature).base64EncodedString())
    }
}

extension KyberPreKeyRecord {
    func upload() throws -> KyberPreKeyUpload {
        KyberPreKeyUpload(keyId: Int(id), publicKey: Data(try publicKey().serialize()).base64EncodedString(),
                          signature: Data(signature).base64EncodedString())
    }
}

extension PreKeyRecord {
    func upload() throws -> PreKeyUpload {
        PreKeyUpload(keyId: Int(id), publicKey: Data(try publicKey().serialize()).base64EncodedString())
    }
}
