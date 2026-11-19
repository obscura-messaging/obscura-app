import Foundation
import XCTest
import ObscuraCore

private final class MemorySessionStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: PersistedSession?

    func save(session: PersistedSession) throws {
        lock.lock()
        stored = session
        lock.unlock()
    }

    func load() throws -> PersistedSession? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func clear() throws {
        lock.lock()
        stored = nil
        lock.unlock()
    }
}

private final class NoopLogger: ObscuraLogger, @unchecked Sendable {
    func log(message: String) {}
    func decryptFailed(sourceUserId: String, reason: String) {}
    func ackFailed(envelopeId: String, reason: String) {}
    func tokenRefreshFailed(attempt: Int32, reason: String) {}
    func preKeySyncFailed(reason: String) {}
    func identityChanged(userId: String) {}
    func sessionEstablishFailed(userId: String, reason: String) {}
    func databaseError(store: String, operation: String, reason: String) {}
}

private final class NoopListener: ClientEventListener, @unchecked Sendable {
    func onConnectionStateChanged(state: ConnectionState) {}
    func onAuthStateChanged(state: AuthState) {}
    func onFriendsChanged() {}
    func onFriendRequestReceived() {}
    func onMessageReceived(model: EntryModel) {}
    func onPeerTypingChanged(peerUserId: String, isTyping: Bool) {}
}

private final class NoopWebSocketHandle: WebSocketHandle, @unchecked Sendable {
    func send(bytes: Data) throws {}
    func closeSocket() {}
}

private final class SimpleFakeTransport: Transport, @unchecked Sendable {
    private let lock = NSLock()
    private var users: [String: (userId: String, password: String)] = [:]
    private var deviceOwners: [String: String] = [:]

    func execute(request: HttpRequest) async throws -> HttpResponse {
        let path = URL(string: request.url)?.path ?? ""
        let bodyDict: [String: Any] = request.body
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]

        switch (request.method, path) {
        case ("POST", "/v1/users"):
            let username = bodyDict["username"] as? String ?? ""
            let password = bodyDict["password"] as? String ?? ""
            let userId = UUID().uuidString.lowercased()
            let deviceId = UUID().uuidString.lowercased()
            let token = "tok_\(UUID().uuidString)"
            let refresh = "ref_\(UUID().uuidString)"
            lock.lock()
            users[username] = (userId, password)
            deviceOwners[deviceId] = userId
            lock.unlock()
            let expiresAt = Int(Date().timeIntervalSince1970) + 3600
            let resp = #"{"token":"\#(token)","refreshToken":"\#(refresh)","expiresAt":\#(expiresAt),"userId":"\#(userId)","deviceId":"\#(deviceId)"}"#
            return HttpResponse(status: 201, body: Data(resp.utf8), retryAfter: nil)

        case ("POST", "/v1/session"):
            let username = bodyDict["username"] as? String ?? ""
            let password = bodyDict["password"] as? String ?? ""
            let deviceId = bodyDict["deviceId"] as? String ?? ""
            lock.lock()
            let user = users[username]
            let owner = deviceOwners[deviceId]
            lock.unlock()
            guard let user, user.password == password else {
                return HttpResponse(status: 401, body: Data("unauthorized".utf8), retryAfter: nil)
            }
            guard owner == user.userId else {
                return HttpResponse(status: 409, body: Data("mismatch".utf8), retryAfter: nil)
            }
            let token = "tok_\(UUID().uuidString)"
            let refresh = "ref_\(UUID().uuidString)"
            let expiresAt = Int(Date().timeIntervalSince1970) + 3600
            let resp = #"{"token":"\#(token)","refreshToken":"\#(refresh)","expiresAt":\#(expiresAt),"userId":"\#(user.userId)","deviceId":"\#(deviceId)"}"#
            return HttpResponse(status: 200, body: Data(resp.utf8), retryAfter: nil)

        case ("POST", "/v1/gateway/ticket"):
            return HttpResponse(status: 200, body: Data(#"{"ticket":"tkt_1"}"#.utf8), retryAfter: nil)

        case ("GET", "/v1/keys"):
            return HttpResponse(status: 200, body: Data(#"{"oneTimePreKeyCount":100,"kyberPreKeyCount":100}"#.utf8), retryAfter: nil)

        case ("DELETE", "/v1/session"):
            return HttpResponse(status: 204, body: Data(), retryAfter: nil)

        default:
            return HttpResponse(status: 404, body: Data("not found".utf8), retryAfter: nil)
        }
    }

    func openWebsocket(url: String, sink: WebSocketSink) throws -> WebSocketHandle {
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.01) {
            sink.onOpen()
        }
        return NoopWebSocketHandle()
    }
}

final class ObscuraCoreTests: XCTestCase {
    func testErrorCodesMatchContract() {
        XCTAssertEqual(errorCode(err: .NotAuthenticated), "NOT_AUTHENTICATED")
        XCTAssertEqual(errorMessage(err: .NotAuthenticated), "Not authenticated")
        XCTAssertEqual(errorCode(err: .InvalidFriendCode), "INVALID_FRIEND_CODE")
        XCTAssertEqual(errorCode(err: .NotPrimary), "NOT_PRIMARY")
        XCTAssertEqual(errorMessage(err: .NotPrimary), "Only the primary device can do this")
        XCTAssertEqual(errorCode(err: .DatabaseUndecryptable(reason: "bad key")), "STORAGE_ERROR")
        XCTAssertEqual(errorMessage(err: .DatabaseUndecryptable(reason: "bad key")), "bad key")
        XCTAssertEqual(errorCode(err: .StorageFailed(reason: "disk full")), "STORAGE_ERROR")
    }

    func testRegisterLoginConnectAndDatabaseKeyEnforcement() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ObscuraCoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let dbPath = tempDir.appendingPathComponent("alice.sqlite").path
        let keyA = Data(repeating: 1, count: 32)
        let keyB = Data(repeating: 2, count: 32)
        let storage = MemorySessionStorage()
        let transport = SimpleFakeTransport()
        let logger = NoopLogger()
        let listener = NoopListener()

        let client = try ObscuraClient.open(
            config: ObscuraClientConfig(
                apiUrl: "https://obscura.test",
                databasePath: dbPath,
                databaseKey: keyA,
                deviceName: "iPhone",
                attachmentCacheDir: tempDir.appendingPathComponent("cache").path
            ),
            sessionStorage: storage,
            transport: transport,
            logger: logger,
            listener: listener
        )

        try await client.register(username: "alice", password: "pass123")
        XCTAssertEqual(client.authState(), .authenticated)
        let isPrimary = try await client.isPrimary()
        XCTAssertTrue(isPrimary)
        XCTAssertFalse(try client.friendCode().isEmpty)

        try await client.connect()
        XCTAssertEqual(client.connectionState(), .connected)

        try await client.logout()
        XCTAssertEqual(client.authState(), .loggedOut)
        let scenario = try await client.login(username: "alice", password: "pass123")
        XCTAssertEqual(scenario, .existingDevice)
        await client.shutdown()

        XCTAssertThrowsError(
            try ObscuraClient.open(
                config: ObscuraClientConfig(
                    apiUrl: "https://obscura.test",
                    databasePath: dbPath,
                    databaseKey: keyB,
                    deviceName: "iPhone",
                    attachmentCacheDir: nil
                ),
                sessionStorage: storage,
                transport: transport,
                logger: logger,
                listener: listener
            )
        ) { error in
            guard case ObscuraError.DatabaseUndecryptable = error else {
                XCTFail("Expected DatabaseUndecryptable, got \(error)")
                return
            }
        }

        let reopened = try ObscuraClient.open(
            config: ObscuraClientConfig(
                apiUrl: "https://obscura.test",
                databasePath: dbPath,
                databaseKey: keyA,
                deviceName: "iPhone",
                attachmentCacheDir: nil
            ),
            sessionStorage: storage,
            transport: transport,
            logger: logger,
            listener: listener
        )
        let restored = await reopened.restorePersistedSession()
        XCTAssertTrue(restored)
        XCTAssertEqual(reopened.authState(), .authenticated)
        try await reopened.wipeDevice()
        let primaryAfterWipe = try await reopened.isPrimary()
        XCTAssertFalse(primaryAfterWipe)
        await reopened.shutdown()
    }
}
