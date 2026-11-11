import Foundation
import GRDB
import LibSignalClient
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

typealias SilentLogger = NoOpLogger

func makeClient(apiURL: String = "https://obscura.invalid", database: DatabaseQueue? = nil,
                storage: MemorySessionStorage = MemorySessionStorage()) throws -> ObscuraClient {
    try ObscuraClient(apiURL: apiURL, database: database ?? ObscuraDatabase.inMemory(), deviceName: "test-device",
                      sessionStorage: storage, logger: SilentLogger())
}

func testNowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// A new device's keys, generated now.
func provisioningKeys(identity: IdentityKeyPair = .generate()) throws -> ProvisioningKeys {
    try PreKeys.generateProvisioningKeys(identity: identity, nowMs: testNowMs())
}

func signalStoreWithIdentity() throws -> PersistentSignalStore {
    let store = PersistentSignalStore(db: try ObscuraDatabase.inMemory(), logger: SilentLogger())
    try store.install(provisioningKeys())
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

/// Inspection the kit itself never needs.
extension PersistentSignalStore {
    func findPreKey(_ id: UInt32) throws -> PreKeyRecord? {
        try db.read { try Data.fetchOne($0, sql: "SELECT record FROM signal_prekeys WHERE key_id = ?", arguments: [id]) }
            .map { try PreKeyRecord(bytes: $0) }
    }

    func findSignedPreKey(_ id: UInt32) throws -> SignedPreKeyRecord? {
        try db.read { try Data.fetchOne($0, sql: "SELECT record FROM signal_signed_prekeys WHERE key_id = ?", arguments: [id]) }
            .map { try SignedPreKeyRecord(bytes: $0) }
    }

    func findKyberPreKey(_ id: UInt32) throws -> KyberPreKeyRecord? {
        try db.read { try Data.fetchOne($0, sql: "SELECT record FROM signal_kyber_prekeys WHERE key_id = ?", arguments: [id]) }
            .map { try KyberPreKeyRecord(bytes: $0) }
    }

    func oneTimePreKeyCount() throws -> Int {
        try db.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM signal_prekeys") ?? 0 }
    }

    func kyberPreKeyCount(lastResort: Bool) throws -> Int {
        try db.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM signal_kyber_prekeys WHERE last_resort = ?", arguments: [lastResort]) ?? 0 }
    }

    func lastResortKyberPreKeyIds() throws -> [UInt32] {
        try db.read { try UInt32.fetchAll($0, sql: "SELECT key_id FROM signal_kyber_prekeys WHERE last_resort = 1 ORDER BY key_id") }
    }

    func signedPreKeyCount() throws -> Int {
        try db.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM signal_signed_prekeys") ?? 0 }
    }

    func savePreKeyState(_ state: PreKeyState) throws {
        try db.write { try PersistentSignalStore.savePreKeyState(state, in: $0) }
    }

    func cleanPreKeys(nowMs: Int64) throws {
        try db.write { try PersistentSignalStore.cleanPreKeys(nowMs: nowMs, in: $0) }
    }
}
