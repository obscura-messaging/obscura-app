import Foundation
import GRDB
import XCTest
@testable import ObscuraKit

final class MemorySessionStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: String]?
    enum Operation { case save, load, clear }
    var failing: Operation? {
        get { lock.withLock { failure } }
        set { lock.withLock { failure = newValue } }
    }
    private var failure: Operation?

    init(_ stored: [String: String]? = nil) {
        self.stored = stored
    }

    var session: [String: String]? { lock.withLock { stored } }
    func save(_ session: [String: String]) throws {
        try lock.withLock {
            if failure == .save { throw ObscuraError.storageFailed("save denied") }
            stored = session
        }
    }
    func load() throws -> [String: String]? {
        try lock.withLock {
            if failure == .load { throw ObscuraError.storageFailed("load denied") }
            return stored
        }
    }
    func clear() throws {
        try lock.withLock {
            if failure == .clear { throw ObscuraError.storageFailed("clear denied") }
            stored = nil
        }
    }
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

func makeClient(apiURL: String = "https://obscura.invalid", database: DatabaseQueue? = nil,
                storage: MemorySessionStorage = MemorySessionStorage()) throws -> ObscuraClient {
    try ObscuraClient(apiURL: apiURL, database: database ?? ObscuraDatabase.inMemory(), deviceName: "test-device",
                      sessionStorage: storage, logger: SilentLogger())
}

func signalStoreWithIdentity() throws -> PersistentSignalStore {
    let store = PersistentSignalStore(db: try ObscuraDatabase.inMemory(), logger: SilentLogger())
    try store.install(SignalKeys.generate())
    return store
}

/// A client signed in as `device`, on its database.
func authenticatedClient(_ device: FakeDevice, username: String = "owner") async throws -> ObscuraClient {
    let client = try makeClient(apiURL: FakeObscuraServer.baseURL, database: device.db)
    try await client.begin(Session(token: device.deviceId, refreshToken: "rt",
                                   expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
                                   userId: device.userId, deviceId: device.deviceId, username: username))
    return client
}

/// Delivers every pending envelope of `device` to `client`; returns how many were acknowledged.
@discardableResult
func deliver(_ device: FakeDevice, to client: ObscuraClient) async -> Int {
    let acks = Locked(0)
    for envelope in device.envelopes() {
        await client.receive(envelope) { _ in acks.withLock { $0 += 1 } }
    }
    return acks.withLock { $0 }
}

func clientMessage(_ build: (inout Obscura_Client_V1_ClientMessage) -> Void) -> Obscura_Client_V1_ClientMessage {
    var message = Obscura_Client_V1_ClientMessage()
    build(&message)
    return message
}

/// Sends `message` from `sender` to every device of `userId` and asserts each accepted.
func send(_ message: Obscura_Client_V1_ClientMessage, from sender: FakeDevice, to userId: String,
          file: StaticString = #filePath, line: UInt = #line) async throws {
    let results = await sender.sender.send(to: userId, try message.serializedData())
    XCTAssertTrue(!results.isEmpty && results.allSatisfy { $0.status == .accepted }, "\(results)", file: file, line: line)
}

func assertThrows(_ expected: ObscuraError, file: StaticString = #filePath, line: UInt = #line,
                  _ body: () async throws -> Void) async {
    do {
        try await body()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch {
        XCTAssertEqual(error as? ObscuraError, expected, file: file, line: line)
    }
}
