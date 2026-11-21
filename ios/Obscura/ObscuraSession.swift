import Foundation
import UIKit
import ObscuraCore

final class BridgeLogger: ObscuraLogger, @unchecked Sendable {
    func log(_ message: String) { NSLog("[ObscuraCore] %@", message) }
    func log(message: String) { log(message) }
    func decryptFailed(sourceUserId: String, reason: String) { log("decrypt failed from \(sourceUserId): \(reason)") }
    func ackFailed(envelopeId: String, reason: String) { log("ack failed \(envelopeId): \(reason)") }
    func tokenRefreshFailed(attempt: Int32, reason: String) { log("token refresh failed (\(attempt)): \(reason)") }
    func preKeySyncFailed(reason: String) { log("prekey sync failed: \(reason)") }
    func identityChanged(userId: String) { log("identity changed: \(userId)") }
    func sessionEstablishFailed(userId: String, reason: String) { log("session establish failed \(userId): \(reason)") }
    func databaseError(store: String, operation: String, reason: String) { log("db error \(store).\(operation): \(reason)") }
}

/** Owns the live client and OS lifecycle. The core is the only session writer. */
@MainActor
final class ObscuraSession: ClientEventListener {
    static let shared = ObscuraSession()
    private static let apiURL: String = {
        guard let url = Bundle.main.object(forInfoDictionaryKey: "ObscuraAPIURL") as? String, !url.isEmpty else {
            fatalError("ObscuraAPIURL missing from Info.plist")
        }
        return url
    }()

    private(set) var client: ObscuraClient?
    private var clientUsername: String?
    private(set) var appInForeground = true
    let logger = BridgeLogger()
    /// This device's name on the account, shown in device lists and on the primary when linking.
    let deviceName = UIDevice.current.model
    private let storage = KeychainSession()
    private let transport = UrlSessionTransport()
    private var restoreTask: Task<Void, Never>?
    var onClientReplaced: ((ObscuraClient?) -> Void)?
    var onConnectionChanged: ((ConnectionState) -> Void)?
    var onAuthChanged: ((AuthState) -> Void)?
    var onFriendsListChanged: (() -> Void)?
    var onMessageReceivedCallback: ((EntryModel) -> Void)?
    var onPeerTypingChangedCallback: ((String, Bool) -> Void)?
    var onAppStateChanged: ((Bool) -> Void)?

    private init() {
        SharedContainer.logStatus { NSLog("%@", $0) }
        do {
            if let username = try storage.load()?.username {
                let restored = try makeUserClient(username: username)
                client = restored
                clientUsername = username.lowercased()
                restoreTask = Task { [weak self] in
                    defer { self?.restoreTask = nil }
                    if !(await restored.restorePersistedSession()) {
                        self?.logger.log("No usable stored session")
                    } else if self?.appInForeground == false {
                        restored.disconnect()
                    }
                }
            }
        } catch {
            logger.log("Session restore failed: \(error)")
        }
        observeAppLifecycle()
    }

    private static var baseDir: URL {
        let root = SharedContainer.containerURL
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return root.appendingPathComponent("ObscuraData")
    }

    private static var attachmentCacheDir: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("attachments")
    }

    func makeUserClient(username: String) throws -> ObscuraClient {
        try validateUsername(username: username)
        // The server normalizes usernames; case variants must open the same database.
        let storageName = username.lowercased()
        do {
            return try openClient(storageName: storageName)
        } catch ObscuraError.DatabaseUndecryptable {
            logger.log("Database cannot be decrypted; discarding it")
            let userDir = Self.baseDir.appendingPathComponent(storageName)
            try? FileManager.default.removeItem(at: userDir)
            if let cacheDir = Self.attachmentCacheDir {
                try? FileManager.default.removeItem(at: cacheDir)
            }
            try? storage.clear()
            return try openClient(storageName: storageName)
        }
    }

    private func openClient(storageName: String) throws -> ObscuraClient {
        let dataDirectory = Self.baseDir.appendingPathComponent(storageName).path
        let protection = [FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(
            atPath: dataDirectory,
            withIntermediateDirectories: true,
            attributes: protection
        )
        let dbPath = (dataDirectory as NSString).appendingPathComponent("obscura.sqlite")
        let key = try DatabaseSecret.getOrCreate(
            userId: storageName,
            accessGroup: SharedContainer.keychainAccessGroup
        )
        let config = ObscuraClientConfig(
            apiUrl: Self.apiURL,
            databasePath: dbPath,
            databaseKey: key,
            deviceName: deviceName,
            attachmentCacheDir: Self.attachmentCacheDir?.path
        )
        let opened = try ObscuraClient.open(
            config: config,
            sessionStorage: storage,
            transport: transport,
            logger: logger,
            listener: self
        )
        try FileManager.default.setAttributes(protection, ofItemAtPath: dbPath)
        return opened
    }

    func replaceClient(username: String) async throws -> ObscuraClient {
        try validateUsername(username: username)
        restoreTask?.cancel()
        await restoreTask?.value
        restoreTask = nil
        if let previous = client {
            client = nil
            clientUsername = nil
            do {
                try await previous.logout()
            } catch {
                await previous.shutdown()
                throw error
            }
            await previous.shutdown()
        }
        let next = try makeUserClient(username: username)
        client = next
        clientUsername = username.lowercased()
        onClientReplaced?(next)
        return next
    }

    func reuseOrReplaceClient(username: String) async throws -> ObscuraClient {
        restoreTask?.cancel()
        await restoreTask?.value
        restoreTask = nil
        let storageName = username.lowercased()
        if let existing = client, clientUsername == storageName, existing.authState() == .loggedOut {
            return existing
        }
        return try await replaceClient(username: username)
    }

    func readyClient() async throws -> ObscuraClient {
        await waitForRestore()
        guard let client else { throw ObscuraError.NotAuthenticated }
        return client
    }

    func waitForRestore() async {
        await restoreTask?.value
    }

    func discardClient() async {
        restoreTask?.cancel()
        await restoreTask?.value
        restoreTask = nil
        let previous = client
        client = nil
        clientUsername = nil
        if let previous {
            await previous.shutdown()
        }
        onClientReplaced?(nil)
    }

    // MARK: - ClientEventListener

    nonisolated func onConnectionStateChanged(state: ConnectionState) {
        Task { @MainActor in self.onConnectionChanged?(state) }
    }

    nonisolated func onAuthStateChanged(state: AuthState) {
        Task { @MainActor in self.onAuthChanged?(state) }
    }

    nonisolated func onFriendsChanged() {
        Task { @MainActor in self.onFriendsListChanged?() }
    }

    nonisolated func onFriendRequestReceived() {}

    nonisolated func onMessageReceived(model: EntryModel) {
        Task { @MainActor in self.onMessageReceivedCallback?(model) }
    }

    nonisolated func onPeerTypingChanged(peerUserId: String, isTyping: Bool) {
        Task { @MainActor in self.onPeerTypingChangedCallback?(peerUserId, isTyping) }
    }

    private func observeAppLifecycle() {
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.appInForeground = true
                self.onAppStateChanged?(true)
                await self.restoreTask?.value
                guard self.appInForeground, let client = self.client, client.authState() == .authenticated else { return }
                do { try await client.connect() }
                catch { self.logger.log("Foreground reconnect failed: \(error)") }
            }
        }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.appInForeground = false
                self.onAppStateChanged?(false)
                self.client?.disconnect()
                if let pendingRestore = self.restoreTask {
                    await pendingRestore.value
                    if !self.appInForeground {
                        self.client?.disconnect()
                    }
                }
            }
        }
    }
}
