import Foundation
import GRDB

enum ObscuraDatabase {
    static let tables = [
        "friends", "friend_list_version", "device_identity", "devices",
        "signal_local_identity", "signal_identities", "signal_prekeys", "signal_signed_prekeys", "signal_sessions",
        "processed_envelopes", "conversation_entries", "story_entries", "profile_entries", "erased_entries",
    ]

    /// SQLCipher-encrypted with a per-user key from the Keychain.
    static func open(path: String, key: Data) throws -> DatabaseQueue {
        var config = Configuration()
        config.prepareDatabase { db in
            try db.usePassphrase(key)
            try db.execute(sql: "PRAGMA kdf_iter = 1") // the key is already 256 bits of entropy
            try db.execute(sql: "PRAGMA cipher_page_size = 4096")
            try db.execute(sql: "PRAGMA secure_delete = ON")
        }
        let db = try DatabaseQueue(path: path, configuration: config)
        try migrator.migrate(db)
        return db
    }

    static func inMemory() throws -> DatabaseQueue {
        var config = Configuration()
        config.prepareDatabase { db in try db.execute(sql: "PRAGMA secure_delete = ON") }
        let db = try DatabaseQueue(configuration: config)
        try migrator.migrate(db)
        return db
    }

    static func wipe(_ db: DatabaseQueue) async throws {
        try await db.write { db in
            try db.execute(sql: "PRAGMA secure_delete = ON")
            for table in tables { try db.execute(sql: "DELETE FROM \(table)") }
        }
        try await truncateWAL(db)
    }

    static func truncateWAL(_ db: DatabaseQueue) async throws {
        try await db.writeWithoutTransaction { db in
            let row = try Row.fetchOne(db, sql: "PRAGMA wal_checkpoint(TRUNCATE)")
            if let row, (row[0] as Int) != 0 {
                throw ObscuraError.storageFailed("WAL checkpoint blocked by another database connection")
            }
        }
    }

    /// Pre-release: installs clear app data when this schema changes. Text the kit does not control is
    /// a BLOB of UTF-8 bytes (see `StoredText.swift`).
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE friends (
                    user_id BLOB PRIMARY KEY,
                    username BLOB NOT NULL,
                    status TEXT NOT NULL
                );
                CREATE TABLE friend_list_version (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    version INTEGER NOT NULL
                );
                CREATE TABLE device_identity (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    device_id TEXT NOT NULL,
                    primary_device_id TEXT NOT NULL
                );
                CREATE TABLE devices (
                    device_id TEXT NOT NULL PRIMARY KEY,
                    user_id TEXT NOT NULL
                );
                CREATE INDEX devices_user_id ON devices(user_id);
                CREATE TABLE signal_local_identity (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    key_pair BLOB NOT NULL,
                    registration_id INTEGER NOT NULL
                );
                CREATE TABLE signal_identities (
                    user_id TEXT PRIMARY KEY,
                    key_data BLOB NOT NULL
                );
                CREATE TABLE signal_prekeys (
                    key_id INTEGER PRIMARY KEY,
                    record BLOB NOT NULL
                );
                CREATE TABLE signal_signed_prekeys (
                    key_id INTEGER PRIMARY KEY,
                    record BLOB NOT NULL,
                    superseded_at INTEGER
                );
                CREATE TABLE signal_sessions (
                    address TEXT PRIMARY KEY,
                    record BLOB NOT NULL
                );
                CREATE TABLE processed_envelopes (
                    envelope_id TEXT PRIMARY KEY
                );
                CREATE TABLE conversation_entries (
                    id BLOB PRIMARY KEY,
                    peer_user_id BLOB NOT NULL,
                    kind TEXT NOT NULL,
                    author_user_id BLOB NOT NULL,
                    sent_at INTEGER NOT NULL,
                    viewed_at INTEGER,
                    expires_at INTEGER NOT NULL,
                    content BLOB NOT NULL,
                    media_ref BLOB,
                    content_key BLOB,
                    nonce BLOB,
                    media_type BLOB,
                    caption BLOB,
                    caption_meta BLOB,
                    display_duration INTEGER NOT NULL,
                    undelivered INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE story_entries (
                    id BLOB PRIMARY KEY,
                    author_user_id BLOB NOT NULL,
                    sent_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    content BLOB NOT NULL,
                    media_ref BLOB,
                    content_key BLOB,
                    nonce BLOB,
                    media_type BLOB,
                    caption_meta BLOB,
                    undelivered INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE profile_entries (
                    user_id BLOB PRIMARY KEY,
                    author_device_id BLOB NOT NULL,
                    updated_at INTEGER NOT NULL,
                    display_name BLOB NOT NULL,
                    bio BLOB NOT NULL,
                    undelivered INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE erased_entries (
                    id BLOB PRIMARY KEY,
                    erased_at INTEGER NOT NULL
                );
                """)
        }
        return migrator
    }
}

/// `?, ?, ?` for an `IN` clause.
func questionMarks(_ count: Int) -> String {
    Array(repeating: "?", count: count).joined(separator: ", ")
}
