import XCTest
@testable import ObscuraKit

final class ObservationTests: XCTestCase {
    func testCancellationConcurrentWithStateChangesNeverBlocksAndPreservesOrdering() async throws {
        let state = StateStream(0)
        let complete = expectation(description: "concurrent cancellation and publication finish")
        let work = Task.detached {
            for i in 1...300 {
                let stream = state.stream()
                let consumer = Task { for await _ in stream {} }
                state.set(i)
                consumer.cancel()
                _ = await consumer.value
            }
            complete.fulfill()
        }
        await fulfillment(of: [complete], timeout: 5)
        work.cancel()
        XCTAssertEqual(state.value, 300)
        let values = try await first(3, of: state.stream()) {
            state.set(301)
            state.set(302)
        }
        XCTAssertEqual(values, [300, 301, 302])
    }

    func testTypingCancellationConcurrentWithExpiryAndClearNeverBlocks() async throws {
        let tracker = TypingTracker()
        let complete = expectation(description: "expiry publication and cancellation finish")
        let work = Task.detached {
            for i in 0..<100 {
                let consumer = Task { for await _ in tracker.observe(contextId: "c") {} }
                tracker.started(contextId: "c", userId: "u", deviceId: "\(i)")
                consumer.cancel()
                tracker.stopped(contextId: "c", deviceId: "\(i)")
                _ = await consumer.value
            }
            let consumer = Task { for await _ in tracker.observe(contextId: "c") {} }
            tracker.started(contextId: "c", userId: "u", deviceId: "expiry")
            try? await Task.sleep(nanoseconds: TypingTracker.expiry)
            consumer.cancel()
            tracker.clear()
            _ = await consumer.value
            complete.fulfill()
        }
        await fulfillment(of: [complete], timeout: 8)
        work.cancel()
    }

    private func first<T: Sendable>(_ count: Int, of stream: AsyncStream<T>, after action: () async throws -> Void = {}) async throws -> [T] {
        let collector = Task {
            var values: [T] = []
            for await value in stream {
                values.append(value)
                if values.count == count { break }
            }
            return values
        }
        try await action()
        let timeout = Task {
            try await Task.sleep(nanoseconds: 8_000_000_000)
            collector.cancel()
        }
        defer { timeout.cancel() }
        return await collector.value
    }

    func testStateStreamsYieldTheCurrentValueThenEachDistinctChange() async throws {
        let state = StateStream(ConnectionState.disconnected)
        let stream = state.stream()

        let values = try await first(3, of: stream) {
            state.set(.connecting)
            state.set(.connecting)
            state.set(.connected)
        }

        XCTAssertEqual(values, [.disconnected, .connecting, .connected])
        XCTAssertEqual(state.value, .connected)
    }

    func testAuthStateStartsLoggedOutAndConnectionDisconnected() async throws {
        let client = try makeClient()
        let auth = try await first(1, of: client.observeAuthState())
        let connection = try await first(1, of: client.observeConnectionState())

        XCTAssertEqual(auth, [.loggedOut])
        XCTAssertEqual(connection, [.disconnected])
    }

    func testFriendsChangedWakesOnSubscribeAndOnEveryChange() async throws {
        let client = try makeClient()

        let wakes: [Void] = try await first(2, of: client.observeFriendsChanged()) {
            try await Task.sleep(nanoseconds: 100_000_000)
            try await client.friends.add("alice-id", username: "alice", status: .accepted)
        }

        XCTAssertEqual(wakes.count, 2)
        let friends = try await client.getFriends()
        XCTAssertEqual(friends.map(\.userId), ["alice-id"])
    }

    func testDebugLogIsANewestFirstRingOf200() throws {
        let logger = RecordingLogger(SilentLogger())
        for i in 0..<250 { logger.log("line \(i)") }

        let lines = logger.snapshot()
        XCTAssertEqual(lines.count, 200)
        XCTAssertEqual(lines.first, "line 249")
        XCTAssertEqual(lines.last, "line 50")
    }

    // MARK: - Typing

    func testTypersAreDistinctSortedUsersAndStoppedClearsOnlyThatDevice() async throws {
        let tracker = TypingTracker()

        let values = try await first(5, of: tracker.observe(contextId: "c")) {
            tracker.started(contextId: "c", userId: "bob", deviceId: "bob-phone")
            tracker.started(contextId: "c", userId: "alice", deviceId: "alice-phone")
            tracker.started(contextId: "c", userId: "alice", deviceId: "alice-laptop")
            tracker.started(contextId: "other", userId: "carol", deviceId: "carol-phone")
            tracker.stopped(contextId: "c", deviceId: "alice-phone")
            tracker.stopped(contextId: "c", deviceId: "alice-laptop")
            tracker.clear()
        }

        XCTAssertEqual(values, [[], ["bob"], ["alice", "bob"], ["bob"], []])
    }

    func testAStartedSignalExpiresFiveSecondsAfterReceipt() async throws {
        let tracker = TypingTracker()
        let start = Date()

        let values = try await first(3, of: tracker.observe(contextId: "c")) {
            tracker.started(contextId: "c", userId: "alice", deviceId: "d")
        }

        XCTAssertEqual(values, [[], ["alice"], []])
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 4.9)
    }

    func testARenewedSignalOutlivesTheFirstOnesExpiry() async throws {
        let tracker = TypingTracker()
        tracker.started(contextId: "c", userId: "alice", deviceId: "d")
        try await Task.sleep(nanoseconds: 3_000_000_000)
        tracker.started(contextId: "c", userId: "alice", deviceId: "d")
        try await Task.sleep(nanoseconds: 3_000_000_000)

        let values = try await first(1, of: tracker.observe(contextId: "c"))
        XCTAssertEqual(values, [["alice"]])
    }
}
