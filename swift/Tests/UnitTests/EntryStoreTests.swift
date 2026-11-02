import XCTest
import GRDB
@testable import ObscuraKit

/// Raw entry storage. Mirrors `ObscuraKit-Kotlin`'s `EntryStoreTest`: the store writes what it is
/// given and returns it unchanged.
final class EntryStoreTests: XCTestCase {

    private func makeStore() throws -> EntryStore {
        EntryStore(db: try ObscuraDatabase.inMemory())
    }

    private func entry(
        _ id: String,
        data: String = #"{"content":"hi"}"#,
        sentAt: UInt64 = 1_000,
        user: String = "user_a",
        device: String = "device_a",
        localMetadata: String? = nil
    ) -> StoredEntry {
        StoredEntry(
            id: id,
            data: data,
            sentAt: sentAt,
            authorUserId: user,
            authorDeviceId: device,
            localMetadata: localMetadata)
    }

    func testPutThenAllReturnsWhatWasWritten() async throws {
        let store = try makeStore()
        try await store.put(model: "directMessage", entry: entry("dm_1"))

        let all = try await store.all(model: "directMessage")

        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].id, "dm_1")
        XCTAssertEqual(all[0].data, #"{"content":"hi"}"#)
        XCTAssertEqual(all[0].sentAt, 1_000)
        XCTAssertEqual(all[0].authorDeviceId, "device_a")
        XCTAssertNil(all[0].localMetadata)
    }

    /// `put` is a blind upsert: an older write replaces a newer one,
    /// because by the time a write reaches this type the app has already decided who wins.
    ///
    /// Merge policy must not be duplicated here or overrule the app's decision.
    func testPutIsBlindAnOlderWriteOverwritesANewerOne() async throws {
        let store = try makeStore()
        try await store.put(model: "pix", entry: entry("pix_1", data: #"{"v":"new"}"#, sentAt: 9_000))
        try await store.put(model: "pix", entry: entry("pix_1", data: #"{"v":"old"}"#, sentAt: 1_000))

        let all = try await store.all(model: "pix")

        XCTAssertEqual(all.count, 1, "same (model, id) is one row")
        XCTAssertEqual(all[0].data, #"{"v":"old"}"#,
                       "the store must not re-decide the merge; the app already did")
        XCTAssertEqual(all[0].sentAt, 1_000)
    }

    func testModelsDoNotBleedIntoEachOther() async throws {
        let store = try makeStore()
        try await store.put(model: "directMessage", entry: entry("a"))
        try await store.put(model: "story", entry: entry("b"))

        let dms = try await store.all(model: "directMessage")
        let stories = try await store.all(model: "story")
        let profiles = try await store.all(model: "profile")

        XCTAssertEqual(dms.map(\.id), ["a"])
        XCTAssertEqual(stories.map(\.id), ["b"])
        XCTAssertTrue(profiles.isEmpty)
    }

    /// `data` is opaque. The kit stores the string it is handed and returns it byte-for-byte — it
    /// does not parse, re-serialize, validate or normalise. Re-serializing would reorder keys and
    /// change the bytes the app hashed or compared.
    func testDataIsStoredVerbatimIncludingContentTheKitCannotParse() async throws {
        let store = try makeStore()
        let notJSON = "this is not json at all {{{"
        try await store.put(model: "weird", entry: entry("w", data: notJSON))

        let all = try await store.all(model: "weird")

        XCTAssertEqual(all.first?.data, notJSON,
                       "the kit must not validate a shape it is forbidden to read")
    }

    func testTextWithEmbeddedNULAndAwkwardCharactersRoundTripsExactlyThroughEveryPath() async throws {
        let awkward = "opaque\0bytes?\u{1}\u{7F}\u{FFFF}\u{FEFF}\u{200D}👩‍👩‍👧\r\n\\%_'\""
        let source = try makeStore()
        let stored = StoredEntry(id: "id\0\(awkward)", data: awkward, sentAt: 7, authorUserId: "user\0x",
                                 authorDeviceId: "device\0x", localMetadata: "meta\0\(awkward)")
        let other = StoredEntry(id: "id", data: "truncated id must not collide", sentAt: 1, authorUserId: "u",
                                authorDeviceId: "d", localMetadata: nil)
        try await source.put(model: "m\0x", entry: stored)
        try await source.put(model: "m\0x", entry: other)
        try await source.put(model: "m", entry: other)

        let all = try await source.all(model: "m\0x")
        XCTAssertEqual(all.first { $0.id == stored.id }, stored)
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.first { $0.id == stored.id }?.data.utf8.count, awkward.utf8.count)
        let got = try await source.get(model: "m\0x", ids: [stored.id])
        XCTAssertEqual(got, [stored])
        let plain = try await source.all(model: "m")
        XCTAssertEqual(plain, [other])

        let snapshot = try await source.snapshot()
        let target = try makeStore()
        try await target.importSnapshot(Obscura_Client_V1_EntrySnapshot(serializedBytes: snapshot.serializedData()))
        let imported = try await target.get(model: "m\0x", ids: [stored.id])
        XCTAssertEqual(imported, [StoredEntry(id: stored.id, data: awkward, sentAt: 7, authorUserId: "user\0x",
                                              authorDeviceId: "device\0x", localMetadata: nil)])

        try await source.erase(model: "m\0x", ids: [stored.id])
        let left = try await source.all(model: "m\0x")
        XCTAssertEqual(left, [other])
    }

    func testUnicodeAndNestedPayloadsSurviveUnchanged() async throws {
        let store = try makeStore()
        let payload = #"{"content":"sunset 🌅","meta":{"x":0.5,"tags":["a","b"]}}"#
        try await store.put(model: "story", entry: entry("s", data: payload))

        let all = try await store.all(model: "story")

        XCTAssertEqual(all.first?.data, payload)
    }

    func testAllOnAnUnknownModelIsEmptyRatherThanAnError() async throws {
        let store = try makeStore()

        let all = try await store.all(model: "neverSeen")

        XCTAssertTrue(all.isEmpty)
    }

    /// The merge metadata has to survive the round trip, because it IS the app's merge input:
    /// REPLACE is a total order on `(sentAt, authorDeviceId)`. A store that dropped or
    /// rewrote either would make the app's tie-break silently non-deterministic across devices.
    func testMergeMetadataRoundTripsExactly() async throws {
        let store = try makeStore()
        try await store.put(model: "pix", entry: entry("p", sentAt: 1_700_000_000_123, device: "device_zzz"))

        let stored = try await store.all(model: "pix")

        XCTAssertEqual(stored.first?.sentAt, 1_700_000_000_123)
        XCTAssertEqual(stored.first?.authorDeviceId, "device_zzz")
    }

    func testLocalMetadataRoundTripsVerbatimAndRemainsNullable() async throws {
        let store = try makeStore()
        let metadata = #"{"uploadState":"complete","attempts":2}"#
        try await store.put(
            model: "pix", entry: entry("with_meta", localMetadata: metadata))
        try await store.put(model: "pix", entry: entry("without_meta"))

        let stored = try await store.all(model: "pix")
        let byID = Dictionary(uniqueKeysWithValues: stored.map { ($0.id, $0) })

        XCTAssertEqual(byID["with_meta"]?.localMetadata, metadata)
        XCTAssertNil(byID["without_meta"]?.localMetadata)
    }

    func testPutReplacesLocalMetadataWithTheAppSuppliedValue() async throws {
        let store = try makeStore()
        try await store.put(
            model: "pix", entry: entry("pix_1", localMetadata: #"{"state":"pending"}"#))
        try await store.put(model: "pix", entry: entry("pix_1", localMetadata: nil))

        let stored = try await store.all(model: "pix")
        XCTAssertNil(stored.first?.localMetadata)
    }

    func testGetReturnsOnlyTheNamedEntriesOfThatModel() async throws {
        let store = try makeStore()
        for id in ["dm_1", "dm_2", "dm_3"] { try await store.put(model: "directMessage", entry: entry(id)) }
        try await store.put(model: "pix", entry: entry("dm_1"))

        let named = try await store.get(model: "directMessage", ids: ["dm_1", "dm_3", "missing"])
        let one = try await store.get(model: "directMessage", ids: ["dm_2"])
        let none = try await store.get(model: "directMessage", ids: [])
        XCTAssertEqual(Set(named.map(\.id)), ["dm_1", "dm_3"])
        XCTAssertEqual(one, [entry("dm_2")])
        XCTAssertEqual(none, [])
    }

    func testEraseRemovesOnlyTheNamedEntries() async throws {
        let store = try makeStore()
        try await store.put(model: "directMessage", entry: entry("dm_1"))
        try await store.put(model: "directMessage", entry: entry("dm_2"))
        try await store.put(model: "directMessage", entry: entry("dm_3"))
        try await store.put(model: "pix", entry: entry("dm_1"))

        try await store.erase(model: "directMessage", ids: ["dm_1", "dm_3"])

        let dms = try await store.all(model: "directMessage")
        let pix = try await store.all(model: "pix")
        XCTAssertEqual(dms.map(\.id), ["dm_2"])
        XCTAssertEqual(pix.map(\.id), ["dm_1"])
    }

    func testErasingMissingEntriesOrNoneIsANoOp() async throws {
        let store = try makeStore()
        try await store.put(model: "directMessage", entry: entry("dm_1"))

        try await store.erase(model: "directMessage", ids: ["never_written"])
        try await store.erase(model: "directMessage", ids: [])

        let all = try await store.all(model: "directMessage")
        XCTAssertEqual(all.count, 1)
    }

    /// The guarantee `erase` exists for: erased content is not recoverable from the database file.
    func testErasedContentIsNotRecoverableFromTheDatabaseFile() async throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".erase-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("erase.db").path

        // The production pragmas without the cipher, so plaintext is visible to the check.
        var config = Configuration()
        config.prepareDatabase { db in try db.execute(sql: "PRAGMA secure_delete = ON") }
        let db = try DatabaseQueue(path: path, configuration: config)
        try ObscuraDatabase.migrator.migrate(db)
        let store = EntryStore(db: db)
        let secrets = ["ERASE-ME-7f3a9c", "ERASE-ME-2b8d41"]
        func onDisk(_ secret: String) -> Bool {
            FileManager.default.contents(atPath: path)?.range(of: Data(secret.utf8)) != nil
        }

        for (i, secret) in secrets.enumerated() {
            try await store.put(model: "directMessage", entry: entry("dm_\(i)", data: #"{"content":"\#(secret)"}"#))
        }
        XCTAssertTrue(secrets.allSatisfy(onDisk), "control: the secrets must be on disk before erase")

        try await store.erase(model: "directMessage", ids: secrets.indices.map { "dm_\($0)" })

        XCTAssertFalse(secrets.contains(where: onDisk), "erased content must not survive in the database file")
    }

    func testEraseAndWipeZeroMainDatabaseAndTruncateWALWithSecureDeleteInitiallyOff() async throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".wal-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("wal.db").path
        let db = try DatabaseQueue(path: path)
        try ObscuraDatabase.migrator.migrate(db)
        try await db.writeWithoutTransaction {
            XCTAssertEqual(try String.fetchOne($0, sql: "PRAGMA journal_mode = WAL"), "wal")
            try $0.execute(sql: "PRAGMA wal_autocheckpoint = 0; PRAGMA secure_delete = OFF")
        }
        let store = EntryStore(db: db)
        let secret = "WAL-ERASE-SECRET-7fa915"
        let metadata = "WAL-OPAQUE-METADATA-39fda1"
        func contains(_ path: String, _ value: String) -> Bool {
            FileManager.default.contents(atPath: path)?.range(of: Data(value.utf8)) != nil
        }
        try await store.put(model: "m", entry: entry("erase", data: secret + String(repeating: "z", count: 6000),
                                                   localMetadata: metadata))
        XCTAssertTrue(contains(path + "-wal", secret), "control: plaintext must occur in the WAL")
        try await db.writeWithoutTransaction { try $0.execute(sql: "PRAGMA wal_checkpoint(FULL)") }
        XCTAssertTrue(contains(path, secret), "control: plaintext must occur in the database")
        try await store.erase(model: "m", ids: ["erase"] + (0..<1200).map { "missing-\($0)" })
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, secret))
            XCTAssertFalse(contains(file, metadata))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)

        try await store.put(model: "m", entry: entry("wipe", data: secret, localMetadata: metadata))
        try await db.write { try $0.execute(sql: "PRAGMA secure_delete = OFF") }
        try await ObscuraDatabase.wipe(db)
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, secret))
            XCTAssertFalse(contains(file, metadata))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)
    }
}
