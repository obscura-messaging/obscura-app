import Foundation
import GRDB

/// One inboxed `AppEntry` row. `payload` is opaque.
public struct InboxRecord: Sendable, Equatable {
    public let id: Int64
    public let senderUserId: String
    public let senderDeviceId: String
    public let modelKey: String
    public let entryId: String
    public let sentAt: UInt64
    public let payload: Data
}

struct InboxInsert: Sendable {
    let envelopeId: String
    let senderUserId: String
    let senderDeviceId: String
    let modelKey: String
    let entryId: String
    let sentAt: UInt64
    let payload: Data
}

/// Decrypted messages persisted before their envelope is acked. Only the receive path writes it;
/// the app drains it.
public actor InboxStore {
    private let db: DatabaseQueue
    private let logger: ObscuraLogger

    init(db: DatabaseQueue, logger: ObscuraLogger) {
        self.db = db
        self.logger = logger
    }

    func contains(envelopeId: String) async throws -> Bool {
        try await db.read { db in
            try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM inbox_rows WHERE envelope_id = ?)",
                              arguments: [envelopeId]) == true
        }
    }

    /// Returns false when the envelope is already inboxed (a redelivery).
    func put(_ record: InboxInsert) async throws -> Bool {
        try await db.write { db in
            try Self.put(record, in: db)
        }
    }

    static func put(_ record: InboxInsert, in db: Database) throws -> Bool {
        let exists = "SELECT EXISTS(SELECT 1 FROM inbox_rows WHERE envelope_id = ?)"
        if try Bool.fetchOne(db, sql: exists, arguments: [record.envelopeId]) == true { return false }
        try db.execute(sql: """
            INSERT INTO inbox_rows (envelope_id, sender_user_id, sender_device_id, model_key, entry_id, sent_at, payload)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, arguments: [
            record.envelopeId, record.senderUserId, record.senderDeviceId,
            record.modelKey.storedText, record.entryId.storedText, Int64(clamping: record.sentAt), record.payload,
        ])
        return true
    }

    /// Oldest first. Side-effect free: rows stay until consumed or discarded.
    public func peek(limit: Int) async throws -> [InboxRecord] {
        try await db.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM inbox_rows ORDER BY id LIMIT ?", arguments: [limit]).map { row in
                InboxRecord(
                    id: row["id"],
                    senderUserId: row["sender_user_id"],
                    senderDeviceId: row["sender_device_id"],
                    modelKey: try row.text("model_key"),
                    entryId: try row.text("entry_id"),
                    // A peer kit may have stored a negative value; UInt64(_:) would trap.
                    sentAt: UInt64(max(0, row["sent_at"] as Int64)),
                    payload: row["payload"]
                )
            }
        }
    }

    public func consume(_ ids: [Int64]) async throws {
        // SQLite caps bound variables at 999 on older builds.
        for start in stride(from: 0, to: ids.count, by: 500) {
            let chunk = Array(ids[start..<min(start + 500, ids.count)])
            try await db.write { db in
                try db.execute(sql: "DELETE FROM inbox_rows WHERE id IN (\(questionMarks(chunk.count)))",
                               arguments: StatementArguments(chunk))
            }
        }
    }

    /// Drops rows the app can never process. Logged because it is deliberate data loss.
    public func discard(_ ids: [Int64], reason: String) async throws {
        guard !ids.isEmpty else { return }
        try await consume(ids)
        logger.log("inbox discard \(ids.count) row(s) reason=\"\(reason)\" ids=\(ids)")
    }

    public func depth() async throws -> Int {
        try await db.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM inbox_rows") ?? 0 }
    }
}
