import GRDB
import XCTest
@testable import ObscuraKit

final class SchemaTests: XCTestCase {
    private func tableNames(in db: DatabaseQueue) throws -> Set<String> {
        try db.read { db in
            let names = try String.fetchAll(db, sql: """
                SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            """)
            return Set(names).subtracting(["grdb_migrations"])
        }
    }

    private func columns(of table: String, in db: DatabaseQueue) throws -> [String] {
        try db.read { db in
            try Row.fetchAll(db, sql: "PRAGMA table_info(\(table))")
                .map { "\($0["name"] as String):\($0["type"] as String)" }
        }
    }

    func testMigratedDatabaseHasExactlyTheTablesAWipeEmpties() throws {
        let db = try ObscuraDatabase.inMemory()
        XCTAssertEqual(try tableNames(in: db), Set(ObscuraDatabase.tables))
    }

    func testWipeEmptiesEveryTable() async throws {
        let db = try ObscuraDatabase.inMemory()
        let store = PersistentSignalStore(db: db, logger: SilentLogger())
        try store.install(provisioningKeys())
        try await FriendStore(db: db).add("peer", username: "alice", status: .accepted)
        try await db.write { try DeviceStore.setLocalDevice("me", primaryDeviceId: "me", in: $0) }
        try await DeviceStore(db: db).add(userId: "peer", deviceIds: ["d"])
        let content = ContentStore(db: db)
        try await db.write { db in
            try ContentStore.recordEnvelope("e", in: db)
            try db.execute(sql: "INSERT INTO erased_entries (id, erased_at) VALUES (?, ?)", arguments: ["dead".storedText, 1])
        }
        try await content.insertConversationItem(ConversationItem(
            id: "1", peerUserId: "peer", kind: "message", authorUserId: "peer",
            sentAt: 1, viewedAt: nil, content: "x", attachment: nil,
            caption: nil, captionMeta: nil, displayDuration: 0
        ))
        try await content.insertStoryItem(StoryItem(
            id: "s1", authorUserId: "peer", sentAt: 1, content: "s",
            attachment: nil, captionMeta: nil
        ))
        try await content.upsertProfile(ProfileItem(
            userId: "peer", authorDeviceId: "d", updatedAt: 1, displayName: "Alice", bio: "hi"
        ))

        try await ObscuraDatabase.wipe(db)

        for table in ObscuraDatabase.tables {
            let count = try await db.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM \(table)") }
            XCTAssertEqual(count, 0, table)
        }
    }

    func testIrreplaceableTableColumnsAreFrozen() throws {
        let db = try ObscuraDatabase.inMemory()

        XCTAssertEqual(try columns(of: "processed_envelopes", in: db), [
            "envelope_id:TEXT",
        ])
        XCTAssertEqual(try columns(of: "conversation_entries", in: db), [
            "id:BLOB", "peer_user_id:BLOB", "kind:TEXT", "author_user_id:BLOB",
            "sent_at:INTEGER", "viewed_at:INTEGER", "expires_at:INTEGER", "content:BLOB",
            "media_ref:BLOB", "content_key:BLOB", "nonce:BLOB", "media_type:BLOB",
            "caption:BLOB", "caption_meta:BLOB", "display_duration:INTEGER", "undelivered:INTEGER",
        ])
        XCTAssertEqual(try columns(of: "story_entries", in: db), [
            "id:BLOB", "author_user_id:BLOB", "sent_at:INTEGER", "expires_at:INTEGER",
            "content:BLOB", "media_ref:BLOB", "content_key:BLOB", "nonce:BLOB",
            "media_type:BLOB", "caption_meta:BLOB", "undelivered:INTEGER",
        ])
        XCTAssertEqual(try columns(of: "profile_entries", in: db), [
            "user_id:BLOB", "author_device_id:BLOB", "updated_at:INTEGER",
            "display_name:BLOB", "bio:BLOB", "undelivered:INTEGER",
        ])
        XCTAssertEqual(try columns(of: "erased_entries", in: db), [
            "id:BLOB", "erased_at:INTEGER",
        ])
    }

    func testMigrationIsIdempotent() throws {
        let db = try ObscuraDatabase.inMemory()
        for _ in 0..<5 { try ObscuraDatabase.migrator.migrate(db) }
        XCTAssertEqual(
            try db.read { try ObscuraDatabase.migrator.appliedMigrations($0) },
            ["v1"]
        )
    }

    func testProfilePrimaryKeyMakesUpsertReplace() throws {
        let db = try ObscuraDatabase.inMemory()
        try db.write { db in
            for (ts, value) in [(1, "first"), (2, "second")] {
                try db.execute(sql: """
                    INSERT OR REPLACE INTO profile_entries
                        (user_id, author_device_id, updated_at, display_name, bio, undelivered)
                    VALUES ('user-a', 'device-a', ?, ?, '', 0)
                """, arguments: [ts, value])
            }
        }

        let values = try db.read { db in
            try String.fetchAll(db, sql: """
                SELECT display_name FROM profile_entries WHERE user_id = 'user-a'
            """)
        }
        XCTAssertEqual(values, ["second"])
    }
}
