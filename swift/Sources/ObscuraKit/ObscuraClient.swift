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

    /// Model key of each newly persisted content message (`directMessage`, `pix`, `seen`, `story`, `profile`).
    /// Single consumer; theoldest keys are dropped when 100 are unread.
    public nonisolated let messageReceived: AsyncStream<String>
    public nonisolated let attachmentCacheDir: URL?

    nonisolated let api: APIClient
    nonisolated let db: DatabaseQueue
    nonisolated let friends: FriendStore
    nonisolated let directory: DeviceStore
    nonisolated let content: ContentStore
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
    var pendingLinkSession: (username: String, password: String, session: LinkSessionResponse)?

    var sessionGeneration = 0
    var refreshTask: Task<TokenStatus, Error>?
    var refreshLoop: Task<Void, Never>?
    var refreshFailures = 0
    /// Pre-key syncs run one at a time on this task, which the session's end cancels.
    var preKeySyncTask: Task<Void, Never>?
    /// Holds at most one request, so requests made while a sync runs collapse into one more sync after it.
    var preKeySyncRequests: AsyncStream<Void>.Continuation?
    /// How often a signed-in client checks its supply anyway: peers fetching bundles use keys up without messaging.
    var preKeyCheckIntervalMs = PreKeys.checkIntervalMs
    /// The least time between syncs, so a backlog of pre-key messages costs one or two checks rather than one each.
    var preKeySyncSpacingMs = PreKeys.syncSpacingMs

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
                sessionStorage: SessionStorage, logger: ObscuraLogger,
                attachmentCacheDir: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("attachments")) throws {
        let protection = [FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(atPath: dataDirectory, withIntermediateDirectories: true, attributes: protection)
        let path = (dataDirectory as NSString).appendingPathComponent("obscura.sqlite")
        let key = try DatabaseSecret.getOrCreate(userId: userId, accessGroup: keychainAccessGroup)
        let db = try ObscuraDatabase.open(path: path, key: key)
        try FileManager.default.setAttributes(protection, ofItemAtPath: path)
        try self.init(apiURL: apiURL, database: db, deviceName: deviceName, sessionStorage: sessionStorage,
                      logger: logger, attachmentCacheDir: attachmentCacheDir)
    }

    init(apiURL: String, database: DatabaseQueue, deviceName: String, sessionStorage: SessionStorage,
         logger: ObscuraLogger,
         attachmentCacheDir: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("attachments")) throws {
        let recording = RecordingLogger(logger)
        self.logger = recording
        self.api = try APIClient(baseURL: apiURL)
        self.db = database
        self.deviceName = deviceName
        self.sessionStorage = sessionStorage
        self.attachmentCacheDir = attachmentCacheDir
        self.friends = FriendStore(db: database)
        self.directory = DeviceStore(db: database)
        self.content = ContentStore(db: database)
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
        preKeySyncTask?.cancel()
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
}
