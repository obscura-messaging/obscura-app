import Foundation
import ObscuraCore
import XCTest

/// Exercises the Rust core only through the UniFFI-generated Swift API.
final class SpikeClientTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("obscura-core-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func dbPath(_ name: String) -> String {
        directory.appendingPathComponent("\(name).db").path
    }

    private func key(_ byte: UInt8) -> Data {
        Data(repeating: byte, count: 32)
    }

    private func open(_ name: String, key byte: UInt8 = 1) throws -> SpikeClient {
        try SpikeClient.open(dbPath: dbPath(name), dbKey: key(byte), name: name, deviceId: 1)
    }

    /// Alice fetches Bob's bundle and sends first, as the app does.
    private func establish() throws -> (alice: SpikeClient, bob: SpikeClient) {
        let alice = try open("alice")
        let bob = try open("bob")
        _ = try alice.createIdentityAndBundle()
        let bundle = try bob.createIdentityAndBundle()
        XCTAssertNotNil(bundle.preKey)
        XCTAssertFalse(bundle.kyberPreKey.isEmpty)
        try alice.processBundle(peerName: "bob", peerDevice: 1, bundle: bundle)
        return (alice, bob)
    }

    func testSessionRoundTripsBothWays() throws {
        var (alice, bob) = try establish()

        let first = try alice.encrypt(peerName: "bob", peerDevice: 1, plaintext: Data("hello bob".utf8))
        XCTAssertEqual(first.kind, .preKey)
        XCTAssertEqual(try bob.decrypt(peerName: "alice", peerDevice: 1, ciphertext: first), Data("hello bob".utf8))

        let reply = try bob.encrypt(peerName: "alice", peerDevice: 1, plaintext: Data("hi alice".utf8))
        XCTAssertEqual(reply.kind, .whisper)
        XCTAssertEqual(try alice.decrypt(peerName: "bob", peerDevice: 1, ciphertext: reply), Data("hi alice".utf8))

        let second = try alice.encrypt(peerName: "bob", peerDevice: 1, plaintext: Data("again".utf8))
        XCTAssertEqual(second.kind, .whisper)

        // Sessions live in the encrypted files, not in memory.
        alice = try open("alice")
        bob = try open("bob")
        XCTAssertEqual(try bob.decrypt(peerName: "alice", peerDevice: 1, ciphertext: second), Data("again".utf8))
        let last = try bob.encrypt(peerName: "alice", peerDevice: 1, plaintext: Data("after reopen".utf8))
        XCTAssertEqual(try alice.decrypt(peerName: "bob", peerDevice: 1, ciphertext: last), Data("after reopen".utf8))
    }

    func testWrongKeyThrowsStorageAndFileIsEncrypted() throws {
        _ = try open("carol", key: 1).createIdentityAndBundle()

        XCTAssertThrowsError(try open("carol", key: 2)) { error in
            guard case .Storage? = error as? CoreError else {
                return XCTFail("expected CoreError.Storage, got \(error)")
            }
        }

        let header = try XCTUnwrap(FileHandle(forReadingAtPath: dbPath("carol"))).readData(ofLength: 16)
        XCTAssertNotEqual(header, Data("SQLite format 3\0".utf8), "database is plaintext")
    }

    func testSwiftLoggerReceivesLines() throws {
        let logger = RecordingLogger()
        setLogger(logger: logger)
        _ = try open("dave").createIdentityAndBundle()
        XCTAssertTrue(logger.lines.contains("opened store"), "\(logger.lines)")
        XCTAssertTrue(logger.lines.contains("generated identity"), "\(logger.lines)")
    }

    func testDecryptAsyncWithAwait() async throws {
        let (alice, bob) = try establish()
        let message = try alice.encrypt(peerName: "bob", peerDevice: 1, plaintext: Data("async hello".utf8))
        let plaintext = try await bob.decryptAsync(peerName: "alice", peerDevice: 1, ciphertext: message)
        XCTAssertEqual(plaintext, Data("async hello".utf8))
    }
}

private final class RecordingLogger: CoreLogger, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func log(message: String) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append(message)
    }
}
