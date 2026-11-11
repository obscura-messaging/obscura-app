import Foundation
import XCTest
@testable import ObscuraKit

/// Restoring a stored session whose access token has expired, against each refresh outcome.
final class SessionRestoreTests: XCTestCase {
    private var server: FakeObscuraServer!

    override func setUp() {
        server = FakeObscuraServer()
        server.failRefresh(status: 503)
    }

    override func tearDown() {
        server.close()
    }

    static let userId = "019f025a-0000-7de6-84b6-000000000001"
    static let deviceId = "019f025a-0000-7de6-84b6-0000000000d1"

    private static let stored = [
        "token": "expired-token",
        "refreshToken": "rt",
        "expiresAt": "1",
        "userId": userId,
        "deviceId": deviceId,
        "username": "alice",
    ]

    private func client(_ storage: MemorySessionStorage, identity: Bool = true) throws -> ObscuraClient {
        let db = try ObscuraDatabase.inMemory()
        if identity {
            try PersistentSignalStore(db: db, logger: SilentLogger()).install(provisioningKeys())
            try db.write { try DeviceStore.setLocalDevice(Self.deviceId, primaryDeviceId: Self.deviceId, in: $0) }
        }
        return try makeClient(apiURL: FakeObscuraServer.baseURL, database: db, storage: storage)
    }

    func testAServerErrorKeepsTheSessionForAnOfflineLaunch() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)

        let restored = await client.restorePersistedSession()

        XCTAssertTrue(restored)
        XCTAssertEqual(client.authState, .authenticated)
        XCTAssertEqual(client.connectionState, .disconnected)
        XCTAssertEqual(storage.session?["refreshToken"], "rt")
    }

    func testAnUnreachableServerKeepsTheSession() async throws {
        server.setOffline()
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)

        let restored = await client.restorePersistedSession()

        XCTAssertTrue(restored)
        XCTAssertEqual(client.authState, .authenticated)
        XCTAssertEqual(storage.session?["refreshToken"], "rt")
    }

    func testARejectedRefreshTokenSignsOutAndForgetsTheSession() async throws {
        server.failRefresh(status: 401)
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)

        let restored = await client.restorePersistedSession()

        XCTAssertFalse(restored)
        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertNil(storage.session)
    }

    func testARefreshRotatesTheStoredTokens() async throws {
        server.acceptRefresh(token: "fresh-token", refreshToken: "rt2", userId: Self.userId, deviceId: Self.deviceId)
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)

        _ = await client.restorePersistedSession()

        XCTAssertEqual(storage.session?["token"], "fresh-token")
        XCTAssertEqual(storage.session?["refreshToken"], "rt2")
        XCTAssertEqual(Set(storage.session?.keys ?? [:].keys), ["token", "refreshToken", "expiresAt", "userId", "deviceId", "username"])
    }

    func testConcurrentRefreshesShareOneRequest() async throws {
        server.acceptRefresh(token: "fresh-token", refreshToken: "rt2", userId: Self.userId, deviceId: Self.deviceId)
        server.resetRequestCount()
        let client = try client(MemorySessionStorage(Self.stored))
        _ = await client.restorePersistedSession()
        server.resetRequestCount()

        async let a = client.refresh()
        async let b = client.refresh()
        async let c = client.refresh()
        let statuses = try await [a, b, c]

        XCTAssertEqual(statuses, [.fresh, .fresh, .fresh])
        XCTAssertEqual(server.requestCount(), 1)
    }

    func testAStoredSessionWithoutASignalIdentityIsNotRestored() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage, identity: false)

        let restored = await client.restorePersistedSession()

        XCTAssertFalse(restored)
        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertNil(storage.session)
    }

    func testAnIncompleteStoredSessionIsNotRestored() async throws {
        var partial = Self.stored
        partial["refreshToken"] = nil
        let storage = MemorySessionStorage(partial)
        let client = try client(storage)

        let restored = await client.restorePersistedSession()

        XCTAssertFalse(restored)
        XCTAssertNil(storage.session)
    }

    func testNothingStoredIsNotRestored() async throws {
        let restored = await (try client(MemorySessionStorage())).restorePersistedSession()
        XCTAssertFalse(restored)
    }

    func testLogoutClearsStorageAndKeepsLocalData() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        _ = await client.restorePersistedSession()
        try await client.friends.add("peer", username: "bob", status: .accepted)

        try await client.logout()

        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertNil(storage.session)
        let userId = await client.userId
        XCTAssertNil(userId)
        let friends = try await client.getFriends()
        XCTAssertEqual(friends.map(\.userId), ["peer"])
        XCTAssertTrue(try client.signalStore.hasIdentity())
    }

    func testWipeDeviceLogsOutAndDeletesLocalData() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        _ = await client.restorePersistedSession()
        try await client.friends.add("peer", username: "bob", status: .accepted)

        try await client.wipeDevice()

        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertNil(storage.session)
        let friends = try await client.getFriends()
        XCTAssertEqual(friends, [])
        XCTAssertFalse(try client.signalStore.hasIdentity())
    }

    func testStoredDeviceMismatchIsClearedRatherThanRestored() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        try await client.db.write { try DeviceStore.setLocalDevice("different-device", primaryDeviceId: "d1", in: $0) }
        let restored = await client.restorePersistedSession()
        XCTAssertFalse(restored)
        XCTAssertNil(storage.session)
    }

    func testSessionSaveLoadAndClearFailuresAreSurfacedAndLogged() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        storage.failing = .load
        let restored = await client.restorePersistedSession()
        XCTAssertFalse(restored)
        XCTAssertTrue(client.getDebugLog().contains { $0.contains("load denied") })
        storage.failing = .save
        let session = try XCTUnwrap(Session(stored: Self.stored))
        do {
            try await client.begin(session)
            XCTFail("session save failure must throw")
        } catch { XCTAssertEqual((error as? ObscuraError)?.code, "STORAGE_ERROR") }
        XCTAssertEqual(client.authState, .loggedOut)
        storage.failing = nil
        try await client.begin(session)
        storage.failing = .clear
        do {
            try await client.logout()
            XCTFail("session clear failure must throw")
        } catch { XCTAssertEqual((error as? ObscuraError)?.code, "STORAGE_ERROR") }
        XCTAssertEqual(client.authState, .loggedOut)
        let userId = await client.userId
        XCTAssertNil(userId)
    }

    func testRefreshSaveFailureDoesNotCommitUnpersistedTokens() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        try await client.begin(try XCTUnwrap(Session(stored: Self.stored)))
        storage.failing = .save
        server.acceptRefresh(token: "fresh-token", refreshToken: "rotated", userId: Self.userId, deviceId: Self.deviceId)
        do {
            _ = try await client.refresh()
            XCTFail("durable token save failure must throw")
        } catch { XCTAssertEqual((error as? ObscuraError)?.code, "STORAGE_ERROR") }
        XCTAssertEqual(storage.session?["refreshToken"], "rt")
        let current = await client.session
        XCTAssertEqual(current?.refreshToken, "rt")
        storage.failing = nil
        try await client.logout()
    }

    func testLateRefreshSuccessCannotResurrectLogoutOrOverwriteReplacement() async throws {
        for replace in [false, true] {
            try await lateRefresh(accept: true, replace: replace)
        }
    }

    func testLateRefreshRejectionCannotLogOutAReplacement() async throws {
        try await lateRefresh(accept: false, replace: true)
    }

    func testLogoutDuringConnectRefreshCannotInstallASocketOrChangeDisconnectedState() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        try await client.begin(try XCTUnwrap(Session(stored: Self.stored)))
        server.acceptRefresh(token: "obsolete-token", refreshToken: "obsolete", userId: Self.userId, deviceId: Self.deviceId)
        let started = expectation(description: "connect waiting for token refresh")
        FakeServerProtocol.onRefresh.withLock { $0 = { started.fulfill() } }
        let connect = Task { try await client.connect() }
        await fulfillment(of: [started], timeout: 3)
        FakeServerProtocol.onRefresh.withLock { $0 = nil }
        try await client.logout()
        FakeServerProtocol.releasePendingRefresh()
        do { try await connect.value; XCTFail("superseded connect must not succeed") }
        catch {}
        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertEqual(client.connectionState, .disconnected)
        let socket = await client.socket
        XCTAssertNil(socket)
        XCTAssertNil(storage.session)
    }

    func testLogoutDuringAttachmentRefreshCannotUploadWithASupersededSession() async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        try await client.begin(try XCTUnwrap(Session(stored: Self.stored)))
        server.acceptRefresh(token: "obsolete-token", refreshToken: "obsolete", userId: Self.userId, deviceId: Self.deviceId)
        server.resetRequestCount()
        let started = expectation(description: "attachment waiting for token refresh")
        FakeServerProtocol.onRefresh.withLock { $0 = { started.fulfill() } }
        let upload = Task { try await client.uploadAttachment(Data([1, 2, 3])) }
        await fulfillment(of: [started], timeout: 3)
        FakeServerProtocol.onRefresh.withLock { $0 = nil }
        try await client.logout()
        FakeServerProtocol.releasePendingRefresh()
        do { _ = try await upload.value; XCTFail("superseded upload must not proceed") }
        catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(server.requestCount(), 2, "only refresh and logout, never attachment upload")
        XCTAssertEqual(client.authState, .loggedOut)
        XCTAssertNil(storage.session)
    }

    private func lateRefresh(accept: Bool, replace: Bool) async throws {
        let storage = MemorySessionStorage(Self.stored)
        let client = try client(storage)
        try await client.begin(try XCTUnwrap(Session(stored: Self.stored)))
        if accept {
            server.acceptRefresh(token: "obsolete-token", refreshToken: "obsolete", userId: Self.userId, deviceId: Self.deviceId)
        } else {
            server.failRefresh(status: 401)
        }
        let started = expectation(description: "refresh request suspended")
        FakeServerProtocol.onRefresh.withLock { $0 = { started.fulfill() } }
        let refresh = Task { try await client.refresh() }
        await fulfillment(of: [started], timeout: 3)
        FakeServerProtocol.onRefresh.withLock { $0 = nil }
        if replace {
            try await client.begin(Session(token: "replacement-token", refreshToken: "replacement",
                                            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
                                            userId: Self.userId, deviceId: Self.deviceId, username: "alice"))
        } else {
            try await client.logout()
        }
        FakeServerProtocol.releasePendingRefresh()
        _ = try await refresh.value
        XCTAssertEqual(client.authState, replace ? .authenticated : .loggedOut)
        XCTAssertEqual(storage.session?["refreshToken"], replace ? "replacement" : nil)
        let current = await client.session
        XCTAssertEqual(current?.refreshToken, replace ? "replacement" : nil)
        try await client.logout()
    }
}
