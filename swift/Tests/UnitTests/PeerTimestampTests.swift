import XCTest
import GRDB
@testable import ObscuraKit

/// Peer-supplied `uint64` timestamps must never trap on the way into or out of SQLite, and a
/// far-future one must not survive to win every later comparison.
final class PeerTimestampTests: XCTestCase {
    private static let aboveInt64Max = UInt64(Int64.max) + 1

    func testTheClampPullsAFarFutureTimestampBackToRoughlyNow() {
        XCTAssertEqual(ObscuraClient.clampFuture(Self.aboveInt64Max, now: 1_000_000), 1_060_000)
        XCTAssertEqual(ObscuraClient.clampFuture(1_060_001, now: 1_000_000), 1_060_000)
        let now = ObscuraClient.nowMs()
        let clamped = ObscuraClient.clampFuture(Self.aboveInt64Max)
        XCTAssertLessThanOrEqual(clamped, ObscuraClient.nowMs() + 60_000)
        XCTAssertGreaterThanOrEqual(clamped, now + 60_000)
    }

    func testASlightlyFastClockIsNotRewritten() {
        XCTAssertEqual(ObscuraClient.clampFuture(1_060_000, now: 1_000_000), 1_060_000)
        XCTAssertEqual(ObscuraClient.clampFuture(1_005_000, now: 1_000_000), 1_005_000)
    }

    func testContentStoreSaturatesInsteadOfTrappingAtBothEnds() async throws {
        let db = try ObscuraDatabase.inMemory()
        let content = ContentStore(db: db)

        try await content.insertStoryItem(StoryItem(
            id: "s1", authorUserId: "user-1", sentAt: Self.aboveInt64Max, content: "hi",
            attachment: nil, captionMeta: nil
        ))

        let written = try await content.allStories()
        XCTAssertEqual(written.map(\.sentAt), [UInt64(Int64.max)], "the write saturates rather than trapping")

        // A peer kit, where proto3 uint64 is a signed Long, can store a negative.
        try await db.write { db in
            try db.execute(sql: "UPDATE story_entries SET sent_at = ? WHERE id = ?", arguments: [Int64(-1), "s1".storedText])
        }

        let read = try await content.allStories()
        XCTAssertEqual(read.map(\.sentAt), [0], "a negative timestamp must clamp to 0, never trap")
    }
}
