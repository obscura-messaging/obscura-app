import XCTest
import GRDB
@testable import ObscuraKit

/// The durable inbox.
///
/// Mirrors `ObscuraKit-Kotlin`'s `InboxStoreTest` so both kits enforce the
/// same durable-inbox contract.
///
/// These check the properties the design is *for*, not the SQL. Each corresponds to a normative rule,
/// and most exist because getting the rule wrong loses messages permanently — the row is the only
/// copy once the kit has acked, because **an ACK is a DELETE**.
final class InboxStoreTests: XCTestCase {

    private let logger = RecordingLogger(SilentLogger())

    private func makeInbox(db: DatabaseQueue? = nil) throws -> InboxStore {
        InboxStore(db: try db ?? ObscuraDatabase.inMemory(), logger: logger)
    }

    private func record(
        _ envelopeId: String,
        payload: Data? = nil,
        modelKey: String = "directMessage"
    ) -> InboxInsert {
        InboxInsert(
            envelopeId: envelopeId,
            senderUserId: "user_peer",
            senderDeviceId: "device_peer",
            modelKey: modelKey,
            entryId: "entry_1",
            sentAt: 1_700_000_000_000,
            payload: payload ?? Data(envelopeId.utf8)
        )
    }

    func testPeerSuppliedTextWithEmbeddedNULRoundTripsExactly() async throws {
        let inbox = try makeInbox()
        _ = try await inbox.put(InboxInsert(
            envelopeId: "e", senderUserId: "user_peer", senderDeviceId: "device_peer",
            modelKey: "model\0suffix", entryId: "entry\0\u{1}👩‍👩‍👧", sentAt: 1, payload: Data([0])))

        let row = try await inbox.peek(limit: 1).first
        XCTAssertEqual(row?.modelKey, "model\0suffix")
        XCTAssertEqual(row?.entryId, "entry\0\u{1}👩‍👩‍👧")
    }

    // MARK: - Idempotence

    /// A failed ack means the envelope is redelivered on the next connection. `envelope_id UNIQUE`
    /// with `INSERT OR IGNORE` is the inbox deduplication boundary.
    func testRedeliveredEnvelopeDoesNotCreateASecondRow() async throws {
        let inbox = try makeInbox()

        let first = try await inbox.put(record("env_1"))
        let second = try await inbox.put(record("env_1"))

        XCTAssertTrue(first, "first insert should create a row")
        XCTAssertFalse(second, "redelivery must be absorbed, not duplicated")
        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 1)
    }

    /// `put` returning false is a *successful* absorption, not a failure — the message is already
    /// durably held. The caller must still ack, because acking is what stops the server sending it a
    /// third time. This pins the contract that makes that safe to rely on.
    func testRedeliveryKeepsTheOriginallyStoredRow() async throws {
        let inbox = try makeInbox()

        _ = try await inbox.put(record("env_1", payload: Data("original".utf8)))
        _ = try await inbox.put(record("env_1", payload: Data("tampered".utf8)))

        let rows = try await inbox.peek(limit: 50)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(String(decoding: rows[0].payload, as: UTF8.self), "original",
                       "INSERT OR IGNORE keeps the first write; a later copy of the same envelope cannot overwrite it")
    }

    /// **`put` must never report "stored" for a message it did not store.** This is the precondition
    /// the entire feature rests on: the caller acks on a successful `put`, and an ack is a DELETE, so
    /// a `put` that lies destroys the message.
    ///
    /// The subtle version of that lie is why this exists. `INSERT OR IGNORE` suppresses EVERY
    /// constraint, not just the `envelope_id UNIQUE` it is written for — so `changesCount`, the
    /// obvious "did a row get added?" implementation, reports a NOT NULL or CHECK violation exactly
    /// as it reports a harmless redelivery. The caller acks on a redelivery.
    ///
    /// Dropping the table is a blunt way to make the write fail, and that is the point: whatever the
    /// reason, "the row is not there" must reach the caller as a throw and never as `false`.
    func testPutThrowsRatherThanReportingStoredWhenTheRowIsNotThere() async throws {
        let db = try ObscuraDatabase.inMemory()
        let inbox = try makeInbox(db: db)
        try await db.write { db in try db.execute(sql: "DROP TABLE inbox_rows") }

        do {
            _ = try await inbox.put(record("env_1"))
            XCTFail("put must throw when the row cannot be stored, never return false")
        } catch {
            // expected
        }
    }

    // MARK: - Peek is side-effect free

    /// The crash-safety property, stated as a test because it reads like a bug otherwise: draining
    /// twice without consuming returns the same rows. An app that dies between peek and consume
    /// reprocesses them, and the merge rules downstream are idempotent so that converges.
    func testPeekingTwiceWithoutConsumingReturnsTheSameRows() async throws {
        let inbox = try makeInbox()
        _ = try await inbox.put(record("env_1"))
        _ = try await inbox.put(record("env_2"))

        let first = try await inbox.peek(limit: 50)
        let second = try await inbox.peek(limit: 50)

        XCTAssertEqual(first.count, 2)
        XCTAssertEqual(first, second)
        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 2, "peek must not consume")
    }

    /// Drain order is oldest-first, because the app processes in arrival order.
    func testPeekReturnsRowsInInsertionOrderAndRespectsTheLimit() async throws {
        let inbox = try makeInbox()
        for i in 0..<5 { _ = try await inbox.put(record("env_\(i)")) }

        let rows = try await inbox.peek(limit: 3)

        XCTAssertEqual(rows.map { String(decoding: $0.payload, as: UTF8.self) },
                       ["env_0", "env_1", "env_2"])
    }

    /// `id` must be monotonic across the whole install, and that is why the column is AUTOINCREMENT.
    /// A plain INTEGER PRIMARY KEY aliases rowid, which SQLite **reuses after deletion** — so a
    /// drained-then-refilled inbox would hand out ids that go backwards, and `peek` orders by id.
    func testIdsKeepIncreasingAfterRowsAreConsumed() async throws {
        let inbox = try makeInbox()
        _ = try await inbox.put(record("env_1"))
        _ = try await inbox.put(record("env_2"))
        let firstBatch = try await inbox.peek(limit: 50)
        try await inbox.consume(firstBatch.map(\.id))

        _ = try await inbox.put(record("env_3"))
        let afterDrain = try await inbox.peek(limit: 50)

        XCTAssertEqual(afterDrain.count, 1)
        XCTAssertGreaterThan(afterDrain[0].id, firstBatch.map(\.id).max()!,
                             "rowid reuse would make drain order go backwards; AUTOINCREMENT prevents it")
    }

    // MARK: - Removal

    func testConsumeIsIdempotentAndAcceptsASubset() async throws {
        let inbox = try makeInbox()
        for i in 0..<3 { _ = try await inbox.put(record("env_\(i)")) }
        let rows = try await inbox.peek(limit: 50)

        try await inbox.consume([rows[0].id])
        try await inbox.consume([rows[0].id]) // again — partial progress is normal, not an error

        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 2)
        let remaining = try await inbox.peek(limit: 50)
        XCTAssertEqual(remaining.map { String(decoding: $0.payload, as: UTF8.self) },
                       ["env_1", "env_2"])
    }

    /// **The 500-id chunking, which the source calls out as load-bearing and nothing tested.**
    /// Each id binds one SQL variable and SQLite caps that at 999 on older builds, so an unchunked
    /// `consume` of a large `peek` throws "too many SQL variables" — precisely when a backlog exists,
    /// which is the one situation in which the drain must not stall. The app chooses the batch
    /// size, so this is reachable by an app that simply drains efficiently.
    ///
    /// 1200 crosses the 999 cap and spans three chunks, so it also proves the loop does not stop
    /// after the first.
    func testConsumeChunksPastTheSQLiteVariableLimit() async throws {
        let inbox = try makeInbox()
        for i in 0..<1200 { _ = try await inbox.put(record("env_\(i)")) }

        let rows = try await inbox.peek(limit: 1200)
        XCTAssertEqual(rows.count, 1200)

        try await inbox.consume(rows.map(\.id))

        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 0, "every chunk must be deleted, not just the first 500")
    }

    /// A negative `sent_at` must saturate to 0, not trap. `UInt64(_:)` on a negative `Int64` is a
    /// hard crash, and `peek` is on the drain path, so it would take the app down every time it
    /// tried to read its own inbox — unrecoverable without deleting the database.
    ///
    /// It is reachable because `AppEntry.timestamp` is proto3 `uint64` and Kotlin's protobuf
    /// surfaces that as a signed `Long`: a peer kit writes a negative and this kit reads it.
    func testANegativeSentAtSaturatesRatherThanTrappingTheDrain() async throws {
        let db = try ObscuraDatabase.inMemory()
        let inbox = try makeInbox(db: db)
        _ = try await inbox.put(record("env_1"))
        // Injected directly because this value can arrive from a peer kit.
        try await db.write { db in
            try db.execute(sql: "UPDATE inbox_rows SET sent_at = ? WHERE envelope_id = ?",
                           arguments: [Int64(-1_700_000_000_000), "env_1"])
        }

        let rows = try await inbox.peek(limit: 50)

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].sentAt, 0, "a negative sent_at must clamp to 0, never trap")
    }

    func testConsumeOfAnEmptyListIsANoOp() async throws {
        let inbox = try makeInbox()
        _ = try await inbox.put(record("env_1"))

        try await inbox.consume([])

        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 1)
    }

    /// A discard is data loss the app chose — the server's copy is already gone, so nothing else
    /// holds these bytes. It must be logged as a security-relevant event; this pins that the hook
    /// fires.
    func testDiscardRemovesRowsAndReportsThemForTheSecurityLog() async throws {
        let inbox = try makeInbox()
        _ = try await inbox.put(record("env_1"))
        _ = try await inbox.put(record("env_2"))

        let rows = try await inbox.peek(limit: 50)
        try await inbox.discard([rows[0].id], reason: "unknown modelKey from a newer peer")

        let depth = try await inbox.depth()
        XCTAssertEqual(depth, 1)
        XCTAssertEqual(logger.snapshot().filter { $0.hasPrefix("inbox discard") }.count, 1)
        XCTAssertTrue(logger.snapshot().contains { $0.contains("unknown modelKey from a newer peer") })
    }

    func testDiscardingNothingDoesNotLogASecurityEvent() async throws {
        let inbox = try makeInbox()

        try await inbox.discard([], reason: "nothing to do")

        XCTAssertTrue(logger.snapshot().isEmpty,
                      "an empty discard is not a data-loss event and must not read as one")
    }

    // MARK: - Depth

    func testDepthReflectsWhatIsWaiting() async throws {
        let inbox = try makeInbox()
        var depth = try await inbox.depth()
        XCTAssertEqual(depth, 0)

        for i in 0..<4 { _ = try await inbox.put(record("env_\(i)")) }
        depth = try await inbox.depth()
        XCTAssertEqual(depth, 4)

        let batch = try await inbox.peek(limit: 2)
        try await inbox.consume(batch.map(\.id))

        depth = try await inbox.depth()
        XCTAssertEqual(depth, 2)
    }

    // MARK: - The record

    func testEveryFieldSurvivesARoundTripIncludingOpaquePayloadBytes() async throws {
        let inbox = try makeInbox()
        // Deliberately not valid UTF-8: the payload is opaque bytes and must not be re-encoded.
        let payload = Data([0, 1, 2, 255, 127, 128])
        _ = try await inbox.put(record("env_1", payload: payload))

        let rows = try await inbox.peek(limit: 50)
        let row = try XCTUnwrap(rows.first)

        XCTAssertEqual(row.senderUserId, "user_peer")
        XCTAssertEqual(row.senderDeviceId, "device_peer")
        XCTAssertEqual(row.modelKey, "directMessage")
        XCTAssertEqual(row.entryId, "entry_1")
        XCTAssertEqual(row.payload, payload)
    }
}
