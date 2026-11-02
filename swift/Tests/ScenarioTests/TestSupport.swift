import Foundation
import GRDB
import XCTest
@testable import ObscuraKit

enum TestServer {
    static let apiURL = ProcessInfo.processInfo.environment["OBSCURA_TEST_API"] ?? "http://localhost:3000"
    static let password = "testpass123456"

    static func username() -> String { "test_\(Int.random(in: 100_000_000...999_999_999))" }
}

final class MemorySessionStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: String]?

    var session: [String: String]? { lock.withLock { stored } }
    func save(_ session: [String: String]) { lock.withLock { stored = session } }
    func load() -> [String: String]? { lock.withLock { stored } }
    func clear() { lock.withLock { stored = nil } }
}

final class SilentLogger: ObscuraLogger {
    func log(_ message: String) {}
    func decryptFailed(sourceUserId: String, reason: String) {}
    func ackFailed(envelopeId: String, reason: String) {}
    func tokenRefreshFailed(attempt: Int, reason: String) {}
    func preKeyReplenishFailed(reason: String) {}
    func identityChanged(userId: String) {}
    func sessionEstablishFailed(userId: String, reason: String) {}
    func databaseError(store: String, operation: String, reason: String) {}
}

struct Timeout: Error {
    let what: String
}

/// Polls until `probe` returns a value. Tests observe the kit through its stores, never through
/// test hooks in production code.
func eventually<T>(_ what: String, timeout: TimeInterval = 20, _ probe: () async throws -> T?) async throws -> T {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        if let value = try await probe() { return value }
        guard Date() < deadline else { throw Timeout(what: what) }
        try await Task.sleep(nanoseconds: 100_000_000)
    }
}

/// A client on its own database: in memory, or in `directory` so a second client can reopen it.
func makeClient(directory: String? = nil, storage: MemorySessionStorage = MemorySessionStorage(),
                deviceName: String = "test-device") throws -> ObscuraClient {
    let db = try directory.map {
        try ObscuraDatabase.open(path: ($0 as NSString).appendingPathComponent("obscura.sqlite"), key: Data(repeating: 7, count: 32))
    } ?? ObscuraDatabase.inMemory()
    return try ObscuraClient(apiURL: TestServer.apiURL, database: db, deviceName: deviceName, sessionStorage: storage,
                             logger: SilentLogger())
}

func temporaryDirectory() throws -> String {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent(".obscura-test-\(UUID().uuidString)").path
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

/// A registered user's device, and the test vocabulary for driving it.
final class TestUser: @unchecked Sendable {
    let client: ObscuraClient
    let username: String
    let userId: String
    let deviceId: String

    private init(client: ObscuraClient, username: String) async throws {
        self.client = client
        self.username = username
        let userId = await client.userId
        let deviceId = await client.deviceId
        self.userId = try XCTUnwrap(userId)
        self.deviceId = try XCTUnwrap(deviceId)
    }

    static func register(_ client: ObscuraClient? = nil) async throws -> TestUser {
        let client = try client ?? makeClient()
        let username = TestServer.username()
        try await client.register(username, TestServer.password)
        return try await TestUser(client: client, username: username)
    }

    /// A device linked to `primary`'s account the way an app does it: the new device shows its code,
    /// the primary approves it. The linked device is connected.
    static func link(to primary: TestUser, name: String = "linked-device", _ client: ObscuraClient? = nil) async throws -> TestUser {
        let client = try client ?? makeClient(deviceName: name)
        let scenario = try await client.login(primary.username, TestServer.password)
        XCTAssertEqual(scenario, .linkRequired)
        let request = try await client.beginLink(primary.username, TestServer.password, deviceName: name)
        async let completed: Void = client.completeLink(request)
        try await primary.client.approveLink(request.code)
        try await completed
        return try await TestUser(client: client, username: primary.username)
    }

    /// Two connected users who are friends.
    static func friends() async throws -> (TestUser, TestUser) {
        let a = try await register()
        let b = try await register()
        try await a.client.connect()
        try await b.client.connect()
        try await befriend(a, b)
        return (a, b)
    }

    /// `a` asks, `b` accepts; returns once both sides see the friendship. Both must be connected.
    static func befriend(_ a: TestUser, _ b: TestUser) async throws {
        try await a.client.befriend(b.userId, username: b.username)
        try await b.waitForFriend(a, .pendingReceived)
        try await b.client.acceptFriend(a.userId)
        try await a.waitForFriend(b, .accepted)
    }

    func waitForFriend(_ other: TestUser, _ status: FriendStatus) async throws {
        _ = try await eventually("\(username) sees \(other.username) as \(status)") {
            try await client.friends.friend(other.userId)?.status == status ? true : nil
        }
    }

    func waitForEntry(_ entryId: String) async throws -> InboxRecord {
        try await eventually("\(username) inboxes \(entryId)") {
            try await client.inbox.peek(limit: 500).first { $0.entryId == entryId }
        }
    }

    func waitForConnection(_ state: ConnectionState) async throws {
        _ = try await eventually("\(username) is \(state)") { client.connectionState == state ? true : nil }
    }

    @discardableResult
    func send(_ entryId: String, to recipients: [TestUser], model: String = "testModel",
              payload: Data = Data("hello".utf8)) async throws -> SendReport {
        try await client.send(to: recipients.map(\.userId), modelKey: model, entryId: entryId,
                              sentAt: UInt64(Date().timeIntervalSince1970 * 1000), payload: payload)
    }

    func sendRaw(_ message: Obscura_Client_V1_ClientMessage, to user: TestUser) async throws {
        try await client.sendControl(message, to: user.userId)
    }
}

extension ObscuraClient {
    /// Closes the socket underneath the client, as a network drop would.
    func dropSocket() {
        socket?.close()
    }
}
