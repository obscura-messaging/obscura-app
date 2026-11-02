import XCTest
import GRDB
@testable import ObscuraKit

/// Peer-supplied `uint64` timestamps must never trap on the way into or out of SQLite, and a
/// far-future one must not survive to win every later comparison.
final class PeerTimestampTests: XCTestCase {
    private static let aboveInt64Max = UInt64(Int64.max) + 1

    func testTheClampPullsAFarFutureTimestampBackToRoughlyNow() {
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        let clamped = ObscuraClient.clampFuture(Self.aboveInt64Max)

        XCTAssertLessThanOrEqual(clamped, now + 61_000)
        XCTAssertGreaterThan(clamped, now)
    }

    func testASlightlyFastClockIsNotRewritten() {
        let slightlyAhead = UInt64(Date().timeIntervalSince1970 * 1000) + 5_000
        XCTAssertEqual(ObscuraClient.clampFuture(slightlyAhead), slightlyAhead)
    }

    func testEntryStoreSaturatesInsteadOfTrappingAtBothEnds() async throws {
        let db = try ObscuraDatabase.inMemory()
        let entries = EntryStore(db: db)

        try await entries.put(model: "story", entry: StoredEntry(
            id: "s1", data: #"{"x":1}"#, sentAt: Self.aboveInt64Max, authorUserId: "user-1", authorDeviceId: "dev-1", localMetadata: nil))

        let written = try await entries.all(model: "story")
        XCTAssertEqual(written.map(\.sentAt), [UInt64(Int64.max)], "the write saturates rather than trapping")

        // A peer kit, where proto3 uint64 is a signed Long, can store a negative.
        try await db.write { db in
            try db.execute(sql: "UPDATE model_entries SET sent_at = ? WHERE id = ?", arguments: [Int64(-1), "s1".storedText])
        }

        let read = try await entries.all(model: "story")
        XCTAssertEqual(read.map(\.sentAt), [0], "a negative timestamp must clamp to 0, never trap")
    }
}
