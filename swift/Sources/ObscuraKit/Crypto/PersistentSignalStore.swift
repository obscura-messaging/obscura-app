import Foundation
import GRDB
import LibSignalClient

/// This device's Signal keys and sessions. Holds no state outside the database.
final class PersistentSignalStore: IdentityKeyStore, PreKeyStore, SignedPreKeyStore, SessionStore, KyberPreKeyStore,
    @unchecked Sendable {
    private struct TransactionContext: StoreContext {
        let database: Database
    }

    /// Signed and last-resort keys other than the active one are kept this long: the server's
    /// queued-message TTL.
    static let archiveAgeMs: Int64 = 30 * 24 * 60 * 60 * 1000
    /// Stale one-time keys are kept this long, as Signal-Android does.
    static let staleOneTimeAgeMs: Int64 = 90 * 24 * 60 * 60 * 1000
    /// At least this many one-time keys of each kind are kept however old they are.
    static let minOneTimeKept = 200

    private let db: DatabaseQueue
    private let logger: ObscuraLogger

    init(db: DatabaseQueue, logger: ObscuraLogger) {
        self.db = db
        self.logger = logger
    }

    func hasIdentity() throws -> Bool {
        try db.read { db in try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM signal_local_identity)") ?? false }
    }

    /// Replaces every Signal record with a new device's identity and keys.
    func install(_ keys: ProvisioningKeys) throws {
        try db.write { db in try Self.install(keys, in: db) }
    }

    static func install(_ keys: ProvisioningKeys, in db: Database) throws {
        for table in ["signal_local_identity", "signal_identities", "signal_prekeys", "signal_signed_prekeys",
                      "signal_kyber_prekeys", "signal_last_resort_key_uses", "signal_prekey_state", "signal_sessions"] {
            try db.execute(sql: "DELETE FROM \(table)")
        }
        try db.execute(sql: "INSERT INTO signal_local_identity (id, key_pair, registration_id) VALUES (1, ?, ?)",
                       arguments: [Data(keys.identity.serialize()), keys.registrationId])
        try storeSignedPreKey(keys.signedPreKey, in: db)
        try storeKyberPreKey(keys.lastResortKyberPreKey, lastResort: true, in: db)
        for preKey in keys.oneTimePreKeys { try storePreKey(preKey, in: db) }
        for preKey in keys.kyberPreKeys { try storeKyberPreKey(preKey, lastResort: false, in: db) }
        try savePreKeyState(keys.state, in: db)
    }

    /// The local device's address, which libsignal pairs with the peer's in every session operation.
    static func localAddress(in db: Database) throws -> ProtocolAddress {
        guard let deviceId = try String.fetchOne(db, sql: "SELECT device_id FROM device_identity WHERE id = 1") else {
            throw SignalError.invalidState("no local device")
        }
        return try Messenger.address(deviceId)
    }

    func localAddress(context: StoreContext = NullContext()) throws -> ProtocolAddress {
        try read(context) { db in try Self.localAddress(in: db) }
    }

    // MARK: - Pre-key bookkeeping

    func preKeyState() throws -> PreKeyState? {
        try db.read { db in try Self.preKeyState(in: db) }
    }

    static func preKeyState(in db: Database) throws -> PreKeyState? {
        try Row.fetchOne(db, sql: "SELECT * FROM signal_prekey_state WHERE id = 1").map(PreKeyState.init(row:))
    }

    func savePreKeyState(_ state: PreKeyState) throws {
        try db.write { db in try Self.savePreKeyState(state, in: db) }
    }

    static func savePreKeyState(_ state: PreKeyState, in db: Database) throws {
        try db.execute(sql: """
            INSERT OR REPLACE INTO signal_prekey_state (
                id, next_signed_id, next_one_time_id, next_kyber_id, active_signed_id, active_last_resort_id,
                signed_rotated_at, last_resort_rotated_at, synced_at,
                pending_signed_id, pending_last_resort_id, pending_one_time_start, pending_kyber_start
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, arguments: [
                state.nextSignedId, state.nextOneTimeId, state.nextKyberId, state.activeSignedId, state.activeLastResortId,
                state.signedRotatedAt, state.lastResortRotatedAt, state.syncedAt,
                state.pendingSignedId, state.pendingLastResortId, state.pendingOneTimeStart, state.pendingKyberStart,
            ])
    }

    static func storePreKey(_ record: PreKeyRecord, in db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO signal_prekeys (key_id, record) VALUES (?, ?)",
                       arguments: [record.id, Data(record.serialize())])
    }

    static func storeSignedPreKey(_ record: SignedPreKeyRecord, in db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO signal_signed_prekeys (key_id, record) VALUES (?, ?)",
                       arguments: [record.id, Data(record.serialize())])
    }

    static func storeKyberPreKey(_ record: KyberPreKeyRecord, lastResort: Bool, in db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO signal_kyber_prekeys (key_id, record, last_resort) VALUES (?, ?, ?)",
                       arguments: [record.id, Data(record.serialize()), lastResort])
    }

    func findPreKey(_ id: UInt32) throws -> PreKeyRecord? {
        try blob("SELECT record FROM signal_prekeys WHERE key_id = ?", id, NullContext()).map { try PreKeyRecord(bytes: $0) }
    }

    func findSignedPreKey(_ id: UInt32) throws -> SignedPreKeyRecord? {
        try blob("SELECT record FROM signal_signed_prekeys WHERE key_id = ?", id, NullContext())
            .map { try SignedPreKeyRecord(bytes: $0) }
    }

    func findKyberPreKey(_ id: UInt32) throws -> KyberPreKeyRecord? {
        try blob("SELECT record FROM signal_kyber_prekeys WHERE key_id = ?", id, NullContext())
            .map { try KyberPreKeyRecord(bytes: $0) }
    }

    func oneTimePreKeyCount() throws -> Int {
        try db.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM signal_prekeys") ?? 0 }
    }

    func kyberPreKeyCount(lastResort: Bool) throws -> Int {
        try db.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM signal_kyber_prekeys WHERE last_resort = ?", arguments: [lastResort]) ?? 0
        }
    }

    func signedPreKeyIds() throws -> [UInt32] {
        try db.read { db in try UInt32.fetchAll(db, sql: "SELECT key_id FROM signal_signed_prekeys ORDER BY key_id") }
    }

    func lastResortKyberPreKeyIds() throws -> [UInt32] {
        try db.read { db in
            try UInt32.fetchAll(db, sql: "SELECT key_id FROM signal_kyber_prekeys WHERE last_resort = 1 ORDER BY key_id")
        }
    }

    /// The one-time keys of a kind stored so far, about to be replaced on the server by a new batch.
    static func markOneTimePreKeysStale(kyber: Bool, nowMs: Int64, in db: Database) throws {
        try db.execute(sql: kyber
            ? "UPDATE signal_kyber_prekeys SET stale_at = ? WHERE stale_at = 0 AND last_resort = 0"
            : "UPDATE signal_prekeys SET stale_at = ? WHERE stale_at = 0", arguments: [nowMs])
    }

    /// Signal-Android's cleanup. Signed and last-resort keys other than the active one are deleted once
    /// older than `archiveAgeMs`, except the youngest of those, which a message in flight may still
    /// name. One-time keys stale for longer than `staleOneTimeAgeMs` are deleted, keeping at least
    /// `minOneTimeKept` of each kind.
    func cleanPreKeys(nowMs: Int64) throws {
        try db.write { db in try Self.cleanPreKeys(nowMs: nowMs, in: db) }
    }

    static func cleanPreKeys(nowMs: Int64, in db: Database) throws {
        let state = try preKeyState(in: db)
        if let active = state?.activeSignedId {
            let records = try Data.fetchAll(db, sql: "SELECT record FROM signal_signed_prekeys").map { try SignedPreKeyRecord(bytes: $0) }
            for id in archived(records.map { ($0.id, $0.timestamp) }, active: active, nowMs: nowMs) {
                try db.execute(sql: "DELETE FROM signal_signed_prekeys WHERE key_id = ?", arguments: [id])
            }
        }
        if let active = state?.activeLastResortId {
            let records = try Data.fetchAll(db, sql: "SELECT record FROM signal_kyber_prekeys WHERE last_resort = 1")
                .map { try KyberPreKeyRecord(bytes: $0) }
            for id in archived(records.map { ($0.id, $0.timestamp) }, active: active, nowMs: nowMs) {
                try db.execute(sql: "DELETE FROM signal_kyber_prekeys WHERE key_id = ?", arguments: [id])
                try db.execute(sql: "DELETE FROM signal_last_resort_key_uses WHERE kyber_id = ?", arguments: [id])
            }
        }
        let cutoff = nowMs - staleOneTimeAgeMs
        // Stale before the cutoff, except the most recent `minOneTimeKept` (fresh first, then latest stale).
        try db.execute(sql: """
            DELETE FROM signal_prekeys WHERE stale_at > 0 AND stale_at < ? AND key_id NOT IN (
                SELECT key_id FROM signal_prekeys ORDER BY stale_at = 0 DESC, stale_at DESC, key_id DESC LIMIT ?)
            """, arguments: [cutoff, minOneTimeKept])
        try db.execute(sql: """
            DELETE FROM signal_kyber_prekeys WHERE last_resort = 0 AND stale_at > 0 AND stale_at < ? AND key_id NOT IN (
                SELECT key_id FROM signal_kyber_prekeys WHERE last_resort = 0
                ORDER BY stale_at = 0 DESC, stale_at DESC, key_id DESC LIMIT ?)
            """, arguments: [cutoff, minOneTimeKept])
    }

    private static func archived(_ keys: [(id: UInt32, createdAt: UInt64)], active: UInt32, nowMs: Int64) -> [UInt32] {
        keys.filter { $0.id != active && nowMs - Int64($0.createdAt) > archiveAgeMs }
            .sorted { $0.createdAt > $1.createdAt }
            .dropFirst()
            .map(\.id)
    }

    private static func address(_ address: ProtocolAddress) -> String {
        "\(address.name).\(address.deviceId)"
    }

    /// Trust is per account: a device address resolves to its user through the device directory.
    private func userId(of address: ProtocolAddress, in db: Database) throws -> String {
        guard let userId = try String.fetchOne(db, sql: "SELECT user_id FROM devices WHERE device_id = ?",
                                               arguments: [address.name]) else {
            throw SignalError.invalidState("device \(address.name) is not in the device directory")
        }
        return userId
    }

    /// Signal callbacks and the receive-path persistence run on the same SQLite transaction.
    func transaction<T>(_ operation: (Database, StoreContext) throws -> T) throws -> T {
        try db.write { database in
            try operation(database, TransactionContext(database: database))
        }
    }

    private func read<T>(_ context: StoreContext, _ operation: (Database) throws -> T) throws -> T {
        if let transaction = context as? TransactionContext { return try operation(transaction.database) }
        return try db.read(operation)
    }

    private func blob(_ sql: String, _ key: DatabaseValueConvertible, _ context: StoreContext) throws -> Data? {
        try read(context) { db in try Data.fetchOne(db, sql: sql, arguments: [key]) }
    }

    private func write<T>(_ context: StoreContext, _ operation: (Database) throws -> T) throws -> T {
        if let transaction = context as? TransactionContext { return try operation(transaction.database) }
        return try db.write(operation)
    }

    private func write(_ sql: String, _ arguments: StatementArguments, _ context: StoreContext) throws {
        try write(context) { db in try db.execute(sql: sql, arguments: arguments) }
    }

    // MARK: - IdentityKeyStore

    func identityKeyPair(context: StoreContext) throws -> IdentityKeyPair {
        guard let data = try blob("SELECT key_pair FROM signal_local_identity WHERE id = ?", 1, context) else {
            throw SignalError.invalidState("no local identity")
        }
        return try IdentityKeyPair(bytes: data)
    }

    func localRegistrationId(context: StoreContext) throws -> UInt32 {
        guard let id = try read(context, { db in try Int64.fetchOne(db, sql: "SELECT registration_id FROM signal_local_identity") }) else {
            throw SignalError.invalidState("no local identity")
        }
        return UInt32(id)
    }

    /// Signal's policy for an unverified contact: the first key seen for an account is trusted, and a
    /// different one is accepted as an account reset. Then every session with the account's devices is
    /// dropped and the change is logged.
    func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws -> IdentityChange {
        let new = Data(identity.serialize())
        let (userId, changed) = try write(context) { db -> (String, Bool) in
            let userId = try self.userId(of: address, in: db)
            let existing = try Data.fetchOne(db, sql: "SELECT key_data FROM signal_identities WHERE user_id = ?", arguments: [userId])
            if let existing, constantTimeEqual(existing, new) { return (userId, false) }
            try db.execute(sql: "INSERT OR REPLACE INTO signal_identities (user_id, key_data) VALUES (?, ?)", arguments: [userId, new])
            guard existing != nil else { return (userId, false) }
            try db.execute(sql: """
                DELETE FROM signal_sessions WHERE address IN (SELECT device_id || '.\(Messenger.deviceSlot)' FROM devices WHERE user_id = ?)
            """, arguments: [userId])
            try db.execute(sql: "DELETE FROM devices WHERE user_id = ? AND device_id != ?", arguments: [userId, address.name])
            return (userId, true)
        }
        if changed { logger.identityChanged(userId: userId) }
        return changed ? .replacedExisting : .newOrUnchanged
    }

    func isTrustedIdentity(_ identity: IdentityKey, for address: ProtocolAddress, direction: Direction,
                           context: StoreContext) throws -> Bool {
        true
    }

    func identity(for address: ProtocolAddress, context: StoreContext) throws -> IdentityKey? {
        try read(context) { db in
            try Data.fetchOne(db, sql: "SELECT key_data FROM signal_identities WHERE user_id = ?",
                              arguments: [self.userId(of: address, in: db)])
        }.map { try IdentityKey(bytes: $0) }
    }

    // MARK: - PreKeyStore

    func loadPreKey(id: UInt32, context: StoreContext) throws -> PreKeyRecord {
        guard let data = try blob("SELECT record FROM signal_prekeys WHERE key_id = ?", id, context) else {
            throw SignalError.invalidKeyIdentifier("no prekey \(id)")
        }
        return try PreKeyRecord(bytes: data)
    }

    func storePreKey(_ record: PreKeyRecord, id: UInt32, context: StoreContext) throws {
        try write("INSERT OR REPLACE INTO signal_prekeys (key_id, record) VALUES (?, ?)", [id, Data(record.serialize())], context)
    }

    func removePreKey(id: UInt32, context: StoreContext) throws {
        try write("DELETE FROM signal_prekeys WHERE key_id = ?", [id], context)
    }

    // MARK: - SignedPreKeyStore

    func loadSignedPreKey(id: UInt32, context: StoreContext) throws -> SignedPreKeyRecord {
        guard let data = try blob("SELECT record FROM signal_signed_prekeys WHERE key_id = ?", id, context) else {
            throw SignalError.invalidKeyIdentifier("no signed prekey \(id)")
        }
        return try SignedPreKeyRecord(bytes: data)
    }

    func storeSignedPreKey(_ record: SignedPreKeyRecord, id: UInt32, context: StoreContext) throws {
        try write("INSERT OR REPLACE INTO signal_signed_prekeys (key_id, record) VALUES (?, ?)", [id, Data(record.serialize())], context)
    }

    // MARK: - SessionStore

    func loadSession(for address: ProtocolAddress, context: StoreContext) throws -> SessionRecord? {
        try blob("SELECT record FROM signal_sessions WHERE address = ?", Self.address(address), context).map { try SessionRecord(bytes: $0) }
    }

    func loadExistingSessions(for addresses: [ProtocolAddress], context: StoreContext) throws -> [SessionRecord] {
        try addresses.compactMap { try loadSession(for: $0, context: context) }
    }

    func storeSession(_ record: SessionRecord, for address: ProtocolAddress, context: StoreContext) throws {
        try write("INSERT OR REPLACE INTO signal_sessions (address, record) VALUES (?, ?)",
                  [Self.address(address), Data(record.serialize())], context)
    }

    // MARK: - KyberPreKeyStore

    func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
        guard let data = try blob("SELECT record FROM signal_kyber_prekeys WHERE key_id = ?", id, context) else {
            throw SignalError.invalidKeyIdentifier("no kyber prekey \(id)")
        }
        return try KyberPreKeyRecord(bytes: data)
    }

    /// Stores a one-time Kyber pre-key; last-resort keys are stored by `install` and pre-key syncs.
    func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
        try write("INSERT OR REPLACE INTO signal_kyber_prekeys (key_id, record, last_resort) VALUES (?, ?, 0)",
                  [id, Data(record.serialize())], context)
    }

    /// A one-time key is deleted. A last-resort key stays, so each session started with it is recorded
    /// instead, and one started again with the same keys and base key is a replay.
    func markKyberPreKeyUsed(id: UInt32, signedPreKeyId: UInt32, baseKey: PublicKey, context: StoreContext) throws {
        try write(context) { db in
            guard try Bool.fetchOne(db, sql: "SELECT last_resort FROM signal_kyber_prekeys WHERE key_id = ?", arguments: [id]) == true else {
                try db.execute(sql: "DELETE FROM signal_kyber_prekeys WHERE key_id = ? AND last_resort = 0", arguments: [id])
                return
            }
            let base = Data(baseKey.serialize())
            let seen = try Bool.fetchOne(db, sql: """
                SELECT EXISTS(SELECT 1 FROM signal_last_resort_key_uses WHERE kyber_id = ? AND signed_id = ? AND base_key = ?)
                """, arguments: [id, signedPreKeyId, base]) ?? false
            if seen { throw SignalError.invalidMessage("base key reused with last-resort Kyber prekey \(id)") }
            try db.execute(sql: "INSERT INTO signal_last_resort_key_uses (kyber_id, signed_id, base_key) VALUES (?, ?, ?)",
                           arguments: [id, signedPreKeyId, base])
        }
    }
}
