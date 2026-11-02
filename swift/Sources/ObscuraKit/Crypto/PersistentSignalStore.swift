import Foundation
import GRDB
import LibSignalClient

/// This device's Signal keys and sessions. Holds no state outside the database.
final class PersistentSignalStore: IdentityKeyStore, PreKeyStore, SignedPreKeyStore, SessionStore, KyberPreKeyStore,
    @unchecked Sendable {
    private struct TransactionContext: StoreContext {
        let database: Database
    }

    static let signedPreKeyId: UInt32 = 1
    /// The server's queued-message TTL.
    static let signedPreKeyGraceMs: Int64 = 30 * 24 * 60 * 60 * 1000

    private let db: DatabaseQueue
    private let logger: ObscuraLogger

    init(db: DatabaseQueue, logger: ObscuraLogger) {
        self.db = db
        self.logger = logger
    }

    func hasIdentity() throws -> Bool {
        try db.read { db in try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM signal_local_identity)") ?? false }
    }

    /// Replaces every Signal record with a new identity and its keys.
    func install(_ keys: SignalKeys) throws {
        try db.write { db in try Self.install(keys, in: db) }
    }

    static func install(_ keys: SignalKeys, in db: Database) throws {
        for table in ["signal_local_identity", "signal_identities", "signal_prekeys", "signal_signed_prekeys", "signal_sessions"] {
            try db.execute(sql: "DELETE FROM \(table)")
        }
        try db.execute(sql: "INSERT INTO signal_local_identity (id, key_pair, registration_id) VALUES (1, ?, ?)",
                       arguments: [Data(keys.identity.serialize()), keys.registrationId])
        try db.execute(sql: "INSERT INTO signal_signed_prekeys (key_id, record) VALUES (?, ?)",
                       arguments: [signedPreKeyId, Data(keys.signedPreKey.serialize())])
        for preKey in keys.preKeys {
            try db.execute(sql: "INSERT INTO signal_prekeys (key_id, record) VALUES (?, ?)",
                           arguments: [preKey.id, Data(preKey.serialize())])
        }
    }

    /// Call once the server has accepted signed prekey `publishedId`. Every older key stops being
    /// advertised now; one superseded longer than the server keeps queued messages can no longer be
    /// named by a deliverable message, so it is deleted.
    func retireSignedPreKeys(publishedId: Int, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws {
        try db.write { db in
            try db.execute(sql: "UPDATE signal_signed_prekeys SET superseded_at = ? WHERE key_id < ? AND superseded_at IS NULL",
                           arguments: [nowMs, publishedId])
            try db.execute(sql: "DELETE FROM signal_signed_prekeys WHERE superseded_at <= ?",
                           arguments: [nowMs - Self.signedPreKeyGraceMs])
        }
    }

    func preKeyCount() throws -> Int {
        try db.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM signal_prekeys") ?? 0 }
    }

    /// Refills with the current identity and a fresh signed prekey; earlier signed keys remain stored.
    func addPreKeys(_ count: UInt32) throws -> PreKeysUpload {
        let identity = try identityKeyPair(context: NullContext())
        return try db.write { db in
            let highestSigned = try Int64.fetchOne(db, sql: "SELECT MAX(key_id) FROM signal_signed_prekeys") ?? 0
            guard let nextSignedId = Int32(exactly: highestSigned + 1) else {
                throw SignalError.invalidState("signed prekey IDs exhausted")
            }
            let signedPreKey = try SignalKeys.generateSignedPreKey(identity: identity, id: UInt32(nextSignedId))
            try db.execute(sql: "INSERT INTO signal_signed_prekeys (key_id, record) VALUES (?, ?)",
                           arguments: [signedPreKey.id, Data(signedPreKey.serialize())])
            let highest = try Int64.fetchOne(db, sql: "SELECT MAX(key_id) FROM signal_prekeys") ?? 0
            let records = try (1...count).map { try PreKeyRecord(id: UInt32(highest) + $0, privateKey: PrivateKey.generate()) }
            for record in records {
                try db.execute(sql: "INSERT INTO signal_prekeys (key_id, record) VALUES (?, ?)",
                               arguments: [record.id, Data(record.serialize())])
            }
            return SignalKeys.upload(signedPreKey: signedPreKey, preKeys: records)
        }
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
    /// dropped and the change is logged. Returns whether the key changed.
    func saveIdentity(_ identity: IdentityKey, for address: ProtocolAddress, context: StoreContext) throws -> Bool {
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
        return changed
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

    // MARK: - KyberPreKeyStore (the server does not distribute Kyber prekeys)

    func loadKyberPreKey(id: UInt32, context: StoreContext) throws -> KyberPreKeyRecord {
        throw SignalError.invalidKeyIdentifier("no kyber prekey \(id)")
    }

    func storeKyberPreKey(_ record: KyberPreKeyRecord, id: UInt32, context: StoreContext) throws {
        throw SignalError.invalidState("kyber prekeys are not supported")
    }

    func markKyberPreKeyUsed(id: UInt32, context: StoreContext) throws {
        throw SignalError.invalidState("kyber prekeys are not supported")
    }
}

/// A new device's keys: the account identity (new for a primary, received for a linked device), its own
/// registration id, signed prekey and one-time prekeys.
struct SignalKeys {
    static let initialPreKeyCount: UInt32 = 100

    let identity: IdentityKeyPair
    let registrationId: UInt32
    let signedPreKey: SignedPreKeyRecord
    let preKeys: [PreKeyRecord]

    static func generate(identity: IdentityKeyPair = .generate()) throws -> SignalKeys {
        SignalKeys(
            identity: identity,
            registrationId: UInt32.random(in: 1...16380),
            signedPreKey: try generateSignedPreKey(identity: identity, id: PersistentSignalStore.signedPreKeyId),
            preKeys: try (1...initialPreKeyCount).map { try PreKeyRecord(id: $0, privateKey: PrivateKey.generate()) }
        )
    }

    static func generateSignedPreKey(identity: IdentityKeyPair, id: UInt32) throws -> SignedPreKeyRecord {
        let privateKey = PrivateKey.generate()
        let signature = identity.privateKey.generateSignature(message: privateKey.publicKey.serialize())
        return try SignedPreKeyRecord(id: id, timestamp: UInt64(Date().timeIntervalSince1970 * 1000),
                                      privateKey: privateKey, signature: signature)
    }

    func accountRequest(username: String, password: String, name: String) -> AccountProvisionRequest {
        let keys = Self.upload(signedPreKey: signedPreKey, preKeys: preKeys)
        return AccountProvisionRequest(
            username: username, password: password, name: name,
            identityKey: Data(identity.publicKey.serialize()).base64EncodedString(),
            registrationId: Int(registrationId), signedPreKey: keys.signedPreKey, oneTimePreKeys: keys.oneTimePreKeys)
    }

    func deviceRequest(name: String, linkSessionId: String) -> CreateDeviceRequest {
        let keys = Self.upload(signedPreKey: signedPreKey, preKeys: preKeys)
        return CreateDeviceRequest(
            linkSessionId: linkSessionId, name: name,
            identityKey: Data(identity.publicKey.serialize()).base64EncodedString(),
            registrationId: Int(registrationId), signedPreKey: keys.signedPreKey, oneTimePreKeys: keys.oneTimePreKeys)
    }

    static func upload(signedPreKey: SignedPreKeyRecord, preKeys: [PreKeyRecord]) -> PreKeysUpload {
        PreKeysUpload(
            signedPreKey: SignedPreKeyUpload(
                keyId: Int(signedPreKey.id),
                publicKey: Data(signedPreKey.publicKey.serialize()).base64EncodedString(),
                signature: Data(signedPreKey.signature).base64EncodedString()),
            oneTimePreKeys: preKeys.map {
                PreKeyUpload(keyId: Int($0.id), publicKey: Data($0.publicKey.serialize()).base64EncodedString())
            }
        )
    }
}
