import XCTest
@testable import ObscuraKit

final class ConnectionTests: XCTestCase {
    func testAFailedConnectReturnsToDisconnectedWithoutRetrying() async throws {
        let client = try ObscuraClient(apiURL: "http://127.0.0.1:1", database: ObscuraDatabase.inMemory(),
                                       deviceName: "d", sessionStorage: MemorySessionStorage(), logger: SilentLogger())
        try await client.begin(Session(token: "t", refreshToken: "r", expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
                                       userId: "u", deviceId: "d", username: "n"))

        do {
            try await client.connect()
            XCTFail("an unreachable server must fail the connection")
        } catch {}
        XCTAssertEqual(client.connectionState, .disconnected)
    }

    func testConcurrentConnectsShareOneSocket() async throws {
        let alice = try await TestUser.register()

        async let first: Void = alice.client.connect()
        async let second: Void = alice.client.connect()
        _ = try await (first, second)
        let socket = await alice.client.socket
        try await alice.client.connect()
        let after = await alice.client.socket

        XCTAssertEqual(alice.client.connectionState, .connected)
        XCTAssertTrue(socket != nil && socket === after)
        await alice.client.disconnect()
    }

    func testADroppedSocketReconnectsAndNothingIsLost() async throws {
        let (alice, bob) = try await TestUser.friends()
        try await alice.send("before-drop", to: [bob])
        _ = try await bob.waitForEntry("before-drop")
        var states = bob.client.observeConnectionState().makeAsyncIterator()
        _ = await states.next()

        await bob.client.dropSocket()
        try await alice.send("during-drop", to: [bob])

        let reconnecting = await states.next()
        XCTAssertEqual(reconnecting, .reconnecting)
        try await bob.waitForConnection(.connected)
        _ = try await bob.waitForEntry("during-drop")
        try await alice.send("after-reconnect", to: [bob])
        _ = try await bob.waitForEntry("after-reconnect")
    }

    func testConnectCutsAPendingBackoffShort() async throws {
        let alice = try await TestUser.register()
        try await alice.client.connect()
        await alice.client.dropSocket()
        try await alice.waitForConnection(.reconnecting)

        try await alice.client.connect()

        XCTAssertEqual(alice.client.connectionState, .connected)
        await alice.client.disconnect()
    }

    func testAnExplicitDisconnectDoesNotReconnect() async throws {
        let alice = try await TestUser.register()
        try await alice.client.connect()

        await alice.client.disconnect()
        try await Task.sleep(nanoseconds: 3_000_000_000)

        XCTAssertEqual(alice.client.connectionState, .disconnected)
    }

    func testTheConnectionSurvivesIdleThroughKeepalivePings() async throws {
        let (alice, bob) = try await TestUser.friends()

        try await Task.sleep(nanoseconds: (GatewaySocket.pingInterval + 5) * 1_000_000_000)

        XCTAssertEqual(alice.client.connectionState, .connected)
        XCTAssertEqual(bob.client.connectionState, .connected)
        try await alice.send("still-alive", to: [bob])
        _ = try await bob.waitForEntry("still-alive")
    }

    func testDataSurvivesARestartAndQueuedEntriesArriveAfterIt() async throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let storage = MemorySessionStorage()
        let alice = try await TestUser.register()
        let bob = try await TestUser.register(makeClient(directory: dir, storage: storage))
        try await alice.client.connect()
        try await bob.client.connect()
        try await TestUser.befriend(alice, bob)
        try await alice.send("before-restart", to: [bob])
        let row = try await bob.waitForEntry("before-restart")
        try await bob.client.entries.put(model: "testModel", entry: StoredEntry(
            id: "before-restart", data: "hello", sentAt: row.sentAt, authorUserId: row.senderUserId,
            authorDeviceId: row.senderDeviceId, localMetadata: nil))
        try await bob.client.inbox.consume([row.id])
        await bob.client.disconnect()

        try await alice.send("while-dead", to: [bob])
        let restarted = try makeClient(directory: dir, storage: storage)
        let restored = await restarted.restorePersistedSession()

        XCTAssertTrue(restored)
        let friend = try await restarted.friends.friend(alice.userId)
        let entries = try await restarted.entries.all(model: "testModel")
        XCTAssertEqual(friend?.status, .accepted)
        XCTAssertEqual(entries.map(\.id), ["before-restart"])
        _ = try await eventually("queued entry after restart") {
            try await restarted.inbox.peek(limit: 50).first { $0.entryId == "while-dead" }
        }
        await restarted.disconnect()
    }
}
