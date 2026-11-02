import Foundation
import GRDB

public enum FriendStatus: String, Codable, Sendable {
    case pendingSent = "pending_sent"
    case pendingReceived = "pending_received"
    case accepted = "accepted"
}

public struct Friend: Codable, Sendable, Equatable {
    public let userId: String
    public let username: String
    public let status: FriendStatus
}

/// The friend list and its version. Every change bumps the version in the same transaction; a
/// linked device instead replaces both with the primary's.
actor FriendStore {
    private let db: DatabaseQueue

    init(db: DatabaseQueue) {
        self.db = db
    }

    /// Yields on subscribe and after every committed change to the friend list.
    nonisolated func changes(logger: ObscuraLogger) -> AsyncStream<Void> {
        AsyncStream { continuation in
            let observation = ValueObservation.tracking { db in try Row.fetchAll(db, sql: "SELECT * FROM friends") }
            let cancellable = observation.start(in: db, onError: { error in
                logger.databaseError(store: "friends", operation: "observe", reason: "\(error)")
            }, onChange: { _ in
                continuation.yield()
            })
            continuation.onTermination = { _ in cancellable.cancel() }
        }
    }

    func add(_ userId: String, username: String, status: FriendStatus) async throws {
        try await db.write { db in
            try Self.add(userId, username: username, status: status, in: db)
        }
    }

    static func add(_ userId: String, username: String, status: FriendStatus, in db: Database) throws {
        try db.execute(sql: """
            INSERT OR REPLACE INTO friends (user_id, username, status) VALUES (?, ?, ?)
        """, arguments: [userId.storedText, username.storedText, status.rawValue])
        try bumpVersion(in: db)
    }

    func friend(_ userId: String) async throws -> Friend? {
        try await db.read { db in
            try Self.friend(userId, in: db)
        }
    }

    static func friend(_ userId: String, in db: Database) throws -> Friend? {
        try Row.fetchOne(db, sql: "SELECT * FROM friends WHERE user_id = ?", arguments: [userId.storedText]).map(Self.friend)
    }

    func all() async throws -> [Friend] {
        try await db.read { db in try Self.all(in: db) }
    }

    private static func all(in db: Database) throws -> [Friend] {
        try Row.fetchAll(db, sql: "SELECT * FROM friends ORDER BY user_id").map(Self.friend)
    }

    func updateStatus(_ userId: String, _ status: FriendStatus) async throws {
        try await db.write { db in
            try Self.updateStatus(userId, status, in: db)
        }
    }

    static func updateStatus(_ userId: String, _ status: FriendStatus, in db: Database) throws {
        try db.execute(sql: "UPDATE friends SET status = ? WHERE user_id = ?",
                       arguments: [status.rawValue, userId.storedText])
        guard db.changesCount == 1 else {
            throw DatabaseError(message: "friend \(userId) is missing; status was not updated")
        }
        try bumpVersion(in: db)
    }

    /// Returns whether a pending-sent friend was removed.
    func removePendingSent(_ userId: String) async throws -> Bool {
        try await db.write { db in
            try db.execute(sql: "DELETE FROM friends WHERE user_id = ? AND status = ?",
                           arguments: [userId.storedText, FriendStatus.pendingSent.rawValue])
            guard db.changesCount == 1 else { return false }
            try Self.bumpVersion(in: db)
            return true
        }
    }

    /// Forgets the friendship and the friend's devices.
    func remove(_ userId: String) async throws {
        try await db.write { db in
            try db.execute(sql: "DELETE FROM friends WHERE user_id = ?", arguments: [userId.storedText])
            let removed = db.changesCount == 1
            try db.execute(sql: """
                DELETE FROM signal_sessions WHERE address IN (SELECT device_id || '.\(Messenger.deviceSlot)' FROM devices WHERE user_id = ?)
            """, arguments: [userId])
            try db.execute(sql: "DELETE FROM devices WHERE user_id = ?", arguments: [userId])
            if removed { try Self.bumpVersion(in: db) }
        }
    }

    static func version(in db: Database) throws -> UInt64 {
        UInt64(try Int64.fetchOne(db, sql: "SELECT version FROM friend_list_version WHERE id = 1") ?? 0)
    }

    private static func bumpVersion(in db: Database) throws {
        try db.execute(sql: """
            INSERT INTO friend_list_version (id, version) VALUES (1, 1)
            ON CONFLICT(id) DO UPDATE SET version = version + 1
        """)
    }

    /// The whole list and its version, read together.
    func listSync() async throws -> Obscura_Client_V1_FriendListSync {
        try await db.read { db in
            var sync = Obscura_Client_V1_FriendListSync()
            sync.version = try Self.version(in: db)
            sync.friends = try Self.all(in: db).map(WireCodec.friendRecord)
            return sync
        }
    }

    /// Replaces the whole list and its version with a primary's.
    static func replace(_ friends: [(userId: String, username: String, status: FriendStatus)], version: UInt64,
                        in db: Database) throws {
        guard let stored = Int64(exactly: version) else { throw DatabaseError(message: "friend list version \(version)") }
        try db.execute(sql: "DELETE FROM friends")
        for friend in friends {
            try db.execute(sql: """
                INSERT INTO friends (user_id, username, status) VALUES (?, ?, ?)
            """, arguments: [friend.userId.storedText, friend.username.storedText, friend.status.rawValue])
        }
        try db.execute(sql: "INSERT OR REPLACE INTO friend_list_version (id, version) VALUES (1, ?)", arguments: [stored])
    }

    private static func friend(_ row: Row) throws -> Friend {
        let userId = try row.text("user_id")
        guard let status = FriendStatus(rawValue: row["status"]) else {
            throw DatabaseError(message: "friend \(userId) has unknown status \(row["status"] as String)")
        }
        return Friend(userId: userId, username: try row.text("username"), status: status)
    }
}
