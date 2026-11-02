import Foundation
import GRDB

public enum ConnectionState: String, Sendable {
    case disconnected, connecting, connected, reconnecting
}

public enum AuthState: String, Sendable {
    case loggedOut, authenticated
}

public enum LoginScenario: Sendable {
    /// Authenticated as the stored local device.
    case existingDevice
    /// No local device: link this device with `beginLink`.
    case linkRequired
    /// The stored local device no longer belongs to the account (unlinked or reset): call `wipeDevice`,
    /// then log in again.
    case deviceMismatch
    case invalidCredentials
}

struct Session: Equatable, Sendable {
    var token: String
    var refreshToken: String
    var expiresAt: Int64
    let userId: String
    let deviceId: String
    let username: String

    init(token: String, refreshToken: String, expiresAt: Int64, userId: String, deviceId: String, username: String) {
        self.token = token
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userId = userId
        self.deviceId = deviceId
        self.username = username
    }

    init?(stored: [String: String]) {
        guard let token = stored["token"], let refreshToken = stored["refreshToken"],
              let expiresAtStr = stored["expiresAt"], let expiresAt = Int64(expiresAtStr), expiresAt > 0,
              let userId = stored["userId"], let deviceId = stored["deviceId"], let username = stored["username"],
              ![token, refreshToken, userId, deviceId, username].contains("") else { return nil }
        self.init(token: token, refreshToken: refreshToken, expiresAt: expiresAt, userId: userId, deviceId: deviceId, username: username)
    }

    var stored: [String: String] {
        [
            "token": token,
            "refreshToken": refreshToken,
            "expiresAt": String(expiresAt),
            "userId": userId,
            "deviceId": deviceId,
            "username": username,
        ]
    }
}

enum TokenStatus: Equatable {
    case fresh, unavailable, rejected
}

public actor ObscuraClient {
    static let tokenExpiryMargin: TimeInterval = 60
    static let preKeyMinimum = 20
    static let preKeyReplenishCount: UInt32 = 50

    public nonisolated let inbox: InboxStore
    public nonisolated let entries: EntryStore
    /// Model key of each newly inboxed `APP_ENTRY`. Single consumer; the inbox is the delivery path,
    /// so the oldest keys are dropped when 100 are unread.
    public nonisolated let messageReceived: AsyncStream<String>

    nonisolated let api: APIClient
    nonisolated let db: DatabaseQueue
    nonisolated let friends: FriendStore
    nonisolated let directory: DeviceStore
    nonisolated let signalStore: PersistentSignalStore
    nonisolated let messenger: Messenger
    nonisolated let logger: RecordingLogger
    nonisolated let deviceName: String
    nonisolated let sessionStorage: SessionStorage
    nonisolated let typing = TypingTracker()
    nonisolated let auth = StateStream(AuthState.loggedOut)
    nonisolated let connection = StateStream(ConnectionState.disconnected)
    nonisolated let messageContinuation: AsyncStream<String>.Continuation

    var session: Session?
    var sender: MessageSender?
    var typingSentAt: [String: Date] = [:]
    var pendingLinkSession: (username: String, password: String, session: LinkSessionResponse)?

    var sessionGeneration = 0
    var refreshTask: Task<TokenStatus, Error>?
    var refreshLoop: Task<Void, Never>?
    var refreshFailures = 0
    var replenishTask: Task<Void, Never>?

    var socket: GatewaySocket?
    var receiveTask: Task<Void, Never>?
    var connectTask: Task<Void, Error>?
    var reconnectTask: Task<Void, Never>?
    var reconnectAttempts = 0
    /// Set by an unrequested drop: until a connect succeeds, every failed attempt schedules the next.
    var recovering = false
    /// Bumped by `disconnect`, so an attempt that outlives it discards its socket.
    var connectionGeneration = 0

    public init(apiURL: String, dataDirectory: String, userId: String, keychainAccessGroup: String?, deviceName: String,
                sessionStorage: SessionStorage, logger: ObscuraLogger) throws {
        let protection = [FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(atPath: dataDirectory, withIntermediateDirectories: true, attributes: protection)
        let path = (dataDirectory as NSString).appendingPathComponent("obscura.sqlite")
        let key = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: keychainAccessGroup)
        let db = try ObscuraDatabase.open(path: path, key: key)
        try FileManager.default.setAttributes(protection, ofItemAtPath: path)
        try self.init(apiURL: apiURL, database: db, deviceName: deviceName, sessionStorage: sessionStorage, logger: logger)
    }

    init(apiURL: String, database: DatabaseQueue, deviceName: String, sessionStorage: SessionStorage,
         logger: ObscuraLogger) throws {
        let recording = RecordingLogger(logger)
        self.logger = recording
        self.api = try APIClient(baseURL: apiURL)
        self.db = database
        self.deviceName = deviceName
        self.sessionStorage = sessionStorage
        self.friends = FriendStore(db: database)
        self.directory = DeviceStore(db: database)
        self.inbox = InboxStore(db: database, logger: recording)
        self.entries = EntryStore(db: database)
        self.signalStore = PersistentSignalStore(db: database, logger: recording)
        self.messenger = Messenger(api: api, store: signalStore)
        (messageReceived, messageContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(100))
        api.onTokenRejected { [weak self] in try await self?.refresh() ?? .rejected }
    }

    deinit {
        refreshLoop?.cancel()
        refreshTask?.cancel()
        reconnectTask?.cancel()
        connectTask?.cancel()
        replenishTask?.cancel()
        receiveTask?.cancel()
        socket?.close()
        messageContinuation.finish()
    }

    // MARK: - Observation

    public nonisolated var authState: AuthState { auth.value }
    public nonisolated func observeAuthState() -> AsyncStream<AuthState> { auth.stream() }

    public nonisolated var connectionState: ConnectionState { connection.value }
    public nonisolated func observeConnectionState() -> AsyncStream<ConnectionState> { connection.stream() }

    /// Yields on subscribe and after every change to the friend list; read it with `getFriends()`.
    public nonisolated func observeFriendsChanged() -> AsyncStream<Void> { friends.changes(logger: logger) }

    /// Newest first.
    public nonisolated func getDebugLog() -> [String] { logger.snapshot() }

    public var userId: String? { session?.userId }
    public var username: String? { session?.username }
    public var deviceId: String? { session?.deviceId }

    /// Whether this device is the account's primary: provisioned first, the only one that links and
    /// unlinks devices and changes the friend list.
    public var isPrimary: Bool {
        get async throws { try await directory.isPrimary() }
    }

    func requireSession() throws -> Session {
        guard let session else { throw ObscuraError.notAuthenticated }
        return session
    }

    // MARK: - Auth

    /// Creates the account and provisions this device as its primary.
    public func register(_ username: String, _ password: String) async throws {
        try await requireUnprovisionedDevice()
        let keys = try SignalKeys.generate()
        let response = try await api.registerUser(keys.accountRequest(username: username, password: password, name: deviceName))
        try await installPrimary(try session(response, username: username), keys: keys)
    }

    /// Only `.existingDevice` changes the client's state.
    public func login(_ username: String, _ password: String) async throws -> LoginScenario {
        guard let localDeviceId = try await directory.localDeviceId() else {
            let linkSession: LinkSessionResponse
            do {
                linkSession = try await api.createLinkSession(username, password)
            } catch ObscuraError.http(let status, _) where status == 401 || status == 403 {
                return .invalidCredentials
            }
            pendingLinkSession = (username, password, linkSession)
            return .linkRequired
        }
        let usable = try signalStore.hasIdentity()
        let response: AuthResponse
        do {
            response = try await api.login(username, password, deviceId: localDeviceId)
        } catch ObscuraError.http(let status, _) where status == 401 || status == 403 {
            return .invalidCredentials
        } catch ObscuraError.http(status: 409, _) {
            return .deviceMismatch
        }
        guard usable, response.deviceId == localDeviceId else { return .deviceMismatch }
        try begin(session(response, username: username))
        return .existingDevice
    }

    /// Deletes every device of the account and its identity on the server, wipes this device's local
    /// data, and provisions this device as the new primary with a new identity.
    public func resetAccount(_ username: String, _ password: String) async throws {
        let keys = try SignalKeys.generate()
        let response = try await api.resetAccount(keys.accountRequest(username: username, password: password, name: deviceName))
        let newSession = try session(response, username: username)
        try await signOut(revoking: false)
        try await ObscuraDatabase.wipe(db)
        try await installPrimary(newSession, keys: keys)
    }

    func requireUnprovisionedDevice() async throws {
        guard try await directory.localDeviceId() == nil, try !signalStore.hasIdentity() else {
            throw ObscuraError.invalidArgument("local device exists; wipeDevice before provisioning")
        }
    }

    func requirePrimary() async throws {
        _ = try requireSession()
        guard try await directory.isPrimary() else { throw ObscuraError.notPrimary }
    }

    private func installPrimary(_ session: Session, keys: SignalKeys) async throws {
        try await db.write { db in
            try PersistentSignalStore.install(keys, in: db)
            try DeviceStore.setLocalDevice(session.deviceId, primaryDeviceId: session.deviceId, in: db)
            try DeviceStore.add(userId: session.userId, deviceId: session.deviceId, in: db)
        }
        try begin(session)
    }

    func session(_ response: AuthResponse, username: String) throws -> Session {
        guard !response.token.isEmpty, !response.refreshToken.isEmpty, response.expiresAt > 0,
              UUID(uuidString: response.userId) != nil, UUID(uuidString: response.deviceId) != nil else {
            throw ObscuraError.protocolViolation("invalid auth response")
        }
        return Session(token: response.token, refreshToken: response.refreshToken, expiresAt: response.expiresAt,
                       userId: response.userId, deviceId: response.deviceId, username: username)
    }

    func begin(_ session: Session, publishAuth: Bool = true) throws {
        try storeSession { try sessionStorage.save(session.stored) }
        stopSessionWork()
        api.setToken(session.token)
        self.session = session
        sender = MessageSender(messenger: messenger, devices: directory, api: api, logger: logger, selfDeviceId: session.deviceId)
        refreshFailures = 0
        startRefreshLoop()
        if publishAuth { auth.set(.authenticated) }
    }

    /// Keeps local data. Revoking the refresh token on the server is best effort.
    public func logout() async throws {
        try await signOut(revoking: true)
    }

    /// `logout()`, then deletes every piece of local kit data.
    public func wipeDevice() async throws {
        try await logout()
        try await ObscuraDatabase.wipe(db)
    }

    /// Without revoking when the server has already deleted this device.
    func signOut(revoking: Bool) async throws {
        let ended = session
        stopSessionWork()
        session = nil
        sender = nil
        api.setToken(nil)
        typing.clear()
        typingSentAt = [:]
        auth.set(.loggedOut)
        try storeSession { try sessionStorage.clear() }
        if revoking, let ended {
            do {
                try await api.logout(token: ended.token)
            } catch {
                logger.log("refresh token revocation failed: \(error)")
            }
        }
    }

    /// True when a stored session was restored; the client is then authenticated and connected if
    /// the server was reachable. False when nothing usable is stored or the refresh token was
    /// rejected.
    public func restorePersistedSession() async -> Bool {
        guard !Task.isCancelled else { return false }
        do {
            guard let stored = try storeSession({ try sessionStorage.load() }) else { return false }
            guard let restored = Session(stored: stored), try signalStore.hasIdentity(),
                  try await directory.localDeviceId() == restored.deviceId,
                  UUID(uuidString: restored.userId) != nil,
                  UUID(uuidString: restored.deviceId) != nil else {
                try storeSession { try sessionStorage.clear() }
                return false
            }
            try begin(restored)
            let generation = sessionGeneration
            guard try await freshToken() != .rejected, generation == sessionGeneration else { return false }
            do {
                try await connect()
            } catch {
                logger.log("restored session offline: \(error)")
            }
            return !Task.isCancelled && generation == sessionGeneration && authState == .authenticated
        } catch {
            logger.databaseError(store: "session", operation: "restore", reason: "\(error)")
            return false
        }
    }

    private func storeSession<T>(_ operation: () throws -> T) throws -> T {
        do { return try operation() }
        catch { throw ObscuraError.storageFailed("session storage: \(error)") }
    }

    private func stopSessionWork() {
        sessionGeneration += 1
        pendingLinkSession = nil
        disconnect()
        refreshTask?.cancel()
        refreshTask = nil
        refreshLoop?.cancel()
        refreshLoop = nil
        replenishTask?.cancel()
        replenishTask = nil
    }

    // MARK: - Token refresh

    func freshToken() async throws -> TokenStatus {
        guard let session else { return .rejected }
        if TimeInterval(session.expiresAt) - Date().timeIntervalSince1970 > Self.tokenExpiryMargin {
            return .fresh
        }
        return try await refresh()
    }

    func requireFreshSession() async throws -> Session {
        try Task.checkCancellation()
        _ = try requireSession()
        let generation = sessionGeneration
        let status = try await freshToken()
        guard generation == sessionGeneration, !Task.isCancelled else { throw CancellationError() }
        guard status != .rejected else { throw ObscuraError.notAuthenticated }
        return try requireSession()
    }

    /// Concurrent callers share one refresh: the refresh token is single-use.
    func refresh() async throws -> TokenStatus {
        try Task.checkCancellation()
        if let refreshTask { return try await refreshTask.value }
        let generation = sessionGeneration
        let task = Task { try await self.performRefresh(generation) }
        refreshTask = task
        defer { if refreshTask == task { refreshTask = nil } }
        return try await task.value
    }

    private func performRefresh(_ generation: Int) async throws -> TokenStatus {
        guard generation == sessionGeneration, !Task.isCancelled, let current = session else { return .rejected }
        do {
            let response = try await api.refreshSession(current.refreshToken)
            guard generation == sessionGeneration, var updated = session else { return .rejected }
            guard response.userId == updated.userId, response.deviceId == updated.deviceId, response.expiresAt > 0 else {
                throw ObscuraError.protocolViolation("refresh returned credentials for another session")
            }
            updated.token = response.token
            updated.refreshToken = response.refreshToken
            updated.expiresAt = response.expiresAt
            try storeSession { try sessionStorage.save(updated.stored) }
            session = updated
            api.setToken(updated.token)
            refreshFailures = 0
            return .fresh
        } catch ObscuraError.http(let status, _) where status == 401 || status == 403 {
            guard generation == sessionGeneration else { return .rejected }
            logger.tokenRefreshFailed(attempt: refreshFailures + 1, reason: "refresh token rejected (\(status))")
            try await signOut(revoking: false)
            return .rejected
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ObscuraError where error.code == "STORAGE_ERROR" || error.code == "PROTOCOL_VIOLATION" {
            throw error
        } catch {
            guard generation == sessionGeneration else { return .rejected }
            refreshFailures += 1
            logger.tokenRefreshFailed(attempt: refreshFailures, reason: "\(error)")
            return .unavailable
        }
    }

    private func startRefreshLoop() {
        refreshLoop?.cancel()
        refreshLoop = Task { [weak self] in
            while let delay = await self?.nextRefreshDelay() {
                guard (try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))) != nil else { return }
                do { _ = try await self?.refresh() }
                catch { self?.logger.databaseError(store: "session", operation: "refresh", reason: "\(error)") }
            }
        }
    }

    /// 80% of the token's remaining lifetime (at least 5 s); after failures, 5 s doubling to 5 min.
    private func nextRefreshDelay() -> TimeInterval? {
        guard let session else { return nil }
        if refreshFailures > 0 { return min(5 * pow(2, Double(min(refreshFailures - 1, 10))), 300) }
        let remaining = TimeInterval(session.expiresAt) - Date().timeIntervalSince1970
        return max(remaining * 0.8, 5)
    }
}
