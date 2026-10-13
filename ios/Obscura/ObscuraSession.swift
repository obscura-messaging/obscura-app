import Foundation
import UIKit
import ObscuraKit

final class BridgeLogger: ObscuraLogger {
    func log(_ message: String) { NSLog("[ObscuraKit] %@", message) }
    func decryptFailed(sourceUserId: String, reason: String) { log("decrypt failed from \(sourceUserId): \(reason)") }
    func ackFailed(envelopeId: String, reason: String) { log("ack failed \(envelopeId): \(reason)") }
    func tokenRefreshFailed(attempt: Int, reason: String) { log("token refresh failed (\(attempt)): \(reason)") }
    func preKeyReplenishFailed(reason: String) { log("prekey replenish failed: \(reason)") }
    func identityChanged(address: String) { log("identity changed: \(address)") }
    func sessionEstablishFailed(userId: String, reason: String) { log("session establish failed \(userId): \(reason)") }
    func databaseError(store: String, operation: String, reason: String) { log("db error \(store).\(operation): \(reason)") }
}

/** Owns the live client and OS lifecycle. The kit is the only session writer. */
@MainActor
final class ObscuraSession {
    static let shared = ObscuraSession()
    private static let apiURL = "https://obscura.barrelmaker.dev"

    private(set) var client: ObscuraClient?
    private(set) var appInForeground = true
    let logger = BridgeLogger()
    private let storage = KeychainSession()
    private var restoreTask: Task<Void, Never>?
    var onClientReplaced: ((ObscuraClient?) -> Void)?
    var onAppStateChanged: ((Bool) -> Void)?

    private init() {
        SharedContainer.logStatus { NSLog("%@", $0) }
        do {
            if let username = try storage.load()?["username"] {
                let restored = try makeUserClient(username: username)
                client = restored
                restoreTask = Task {
                    if !(await restored.restorePersistedSession()) {
                        logger.log("No usable stored session")
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

    func makeUserClient(username: String) throws -> ObscuraClient {
        guard username.range(of: "^[a-zA-Z0-9_]{3,50}$", options: .regularExpression) != nil else {
            throw ObscuraError.invalidArgument("Invalid username")
        }
        // The server normalizes usernames; case variants must open the same database.
        let storageName = username.lowercased()
        return try ObscuraClient(
            apiURL: Self.apiURL,
            dataDirectory: Self.baseDir.appendingPathComponent(storageName).path,
            userId: storageName,
            keychainAccessGroup: SharedContainer.keychainAccessGroup,
            deviceName: UIDevice.current.model,
            sessionStorage: storage,
            logger: logger
        )
    }

    func replaceClient(_ next: ObscuraClient?) async throws {
        restoreTask?.cancel()
        await restoreTask?.value
        restoreTask = nil
        if let previous = client { try await previous.logout() }
        client = next
        onClientReplaced?(next)
    }

    func readyClient() async throws -> ObscuraClient {
        await waitForRestore()
        guard let client else { throw ObscuraError.notAuthenticated }
        return client
    }

    func waitForRestore() async {
        await restoreTask?.value
    }

    func discardClient() {
        client = nil
        onClientReplaced?(nil)
    }

    private func observeAppLifecycle() {
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                appInForeground = true
                onAppStateChanged?(true)
                await restoreTask?.value
                guard let client, client.authState == .authenticated else { return }
                do { try await client.connect() }
                catch { logger.log("Foreground reconnect failed: \(error)") }
            }
        }
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.appInForeground = false
                self?.onAppStateChanged?(false)
            }
        }
    }
}
