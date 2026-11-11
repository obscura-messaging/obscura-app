import XCTest
@testable import ObscuraKit

final class TypingTests: XCTestCase {
    // DIAGNOSTIC (not for merge): test boundaries on the same clock as the kit's log.
    override func setUp() {
        super.setUp()
        trace("TEST START \(name)")
    }

    override func tearDown() {
        trace("TEST END \(name) failures=\(testRun?.failureCount ?? -1)")
        super.tearDown()
    }

    func testTypingReachesOnlyTheNamedRecipientsAndStoppedClearsIt() async throws {
        let (alice, bob) = try await TestUser.friends()
        let carol = try await TestUser.register()
        try await carol.client.connect()
        try await TestUser.befriend(alice, carol)
        var bobSees = bob.client.observeTyping(contextId: "opaque-context").makeAsyncIterator()
        let initial = await bobSees.next()
        XCTAssertEqual(initial, [])

        try await alice.client.sendTyping(to: [bob.userId, bob.userId, alice.userId], contextId: "opaque-context", state: .started)
        let started = await bobSees.next()
        XCTAssertEqual(started, [alice.userId])

        try await alice.client.sendTyping(to: [bob.userId], contextId: "opaque-context", state: .stopped)
        let stopped = await bobSees.next()
        XCTAssertEqual(stopped, [])

        // Carol is a friend but was not named; a marker entry proves her queue was drained.
        try await alice.send("marker", to: [carol])
        _ = try await carol.waitForEntry("marker")
        var carolSees = carol.client.observeTyping(contextId: "opaque-context").makeAsyncIterator()
        let carolTypers = await carolSees.next()
        XCTAssertEqual(carolTypers, [])
    }
}
