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
        try store.install(SignalKeys.generate())
        try await FriendStore(db: db).add("peer", username: "alice", status: .accepted)
        try await db.write { try DeviceStore.setLocalDevice("me", primaryDeviceId: "me", in: $0) }
        try await DeviceStore(db: db).add(userId: "peer", deviceIds: ["d"])
        _ = try await InboxStore(db: db, logger: SilentLogger()).put(InboxInsert(
            envelopeId: "e", senderUserId: "peer", senderDeviceId: "d",
            modelKey: "m", entryId: "1", sentAt: 1, payload: Data([1])))
        try await EntryStore(db: db).put(model: "m", entry: StoredEntry(
            id: "1", data: "x", sentAt: 1, authorUserId: "peer", authorDeviceId: "d", localMetadata: nil))

        try await ObscuraDatabase.wipe(db)

        for table in ObscuraDatabase.tables {
            let count = try await db.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM \(table)") }
            XCTAssertEqual(count, 0, table)
        }
    }

    func testIrreplaceableTableColumnsAreFrozen() throws {
        let db = try ObscuraDatabase.inMemory()

        XCTAssertEqual(try columns(of: "model_entries", in: db), [
            "model_name:BLOB", "id:BLOB", "data:BLOB", "sent_at:INTEGER",
            "author_user_id:BLOB", "author_device_id:BLOB", "local_metadata:BLOB",
        ])
        XCTAssertEqual(try columns(of: "inbox_rows", in: db), [
            "id:INTEGER", "envelope_id:TEXT", "sender_user_id:TEXT",
            "sender_device_id:TEXT", "model_key:BLOB", "entry_id:BLOB",
            "sent_at:INTEGER", "payload:BLOB",
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

    func testEntryPrimaryKeyMakesUpsertReplace() throws {
        let db = try ObscuraDatabase.inMemory()
        try db.write { db in
            for value in ["first", "second"] {
                try db.execute(sql: """
                    INSERT OR REPLACE INTO model_entries
                        (model_name, id, data, sent_at, author_user_id, author_device_id)
                    VALUES ('story', 'e1', ?, 1, 'user-a', 'device-a')
                """, arguments: [value])
            }
        }

        let values = try db.read { db in
            try String.fetchAll(db, sql: """
                SELECT data FROM model_entries WHERE model_name = 'story' AND id = 'e1'
            """)
        }
        XCTAssertEqual(values, ["second"])
    }
}
