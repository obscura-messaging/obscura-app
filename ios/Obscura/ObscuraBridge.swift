import Foundation
import React
import ObscuraKit
import AVFoundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
import UserNotifications

/// Thin React Native bridge — the iOS analog of `ObscuraBridgeModule.kt`.
/// Owns NO Obscura state: client lifecycle / persistence / app-state live in
/// `ObscuraSession`. This class:
///
///   - Relays the kit's unified `observeEvents()` stream to JS as the single
///     `ObscuraEvent` stream (discriminated by `type`, per docs/BRIDGE.md).
///   - Translates `@objc` RPC methods into `ObscuraSession.client` calls and
///     marshals between JS and Swift types.
///
/// Registered with React via `ObscuraBridge.m` (`RCT_EXTERN_MODULE`).
@objc(ObscuraBridge)
final class ObscuraBridge: RCTEventEmitter {
    private static weak var shared: ObscuraBridge?

    private var hasListeners = false
    private var eventTask: Task<Void, Never>?
    /// Active typing observations, keyed by conversationId.
    private var typingTasks: [String: Task<Void, Never>] = [:]

    /// Consume-once cold-start deep-link target. Notification callbacks do not
    /// populate it until iOS push delivery is implemented.
    static var pendingLaunchScreen: String?

    override init() {
        super.init()
        ObscuraBridge.shared = self
        // Process foreground/background -> appStateChanged event.
        ObscuraSession.shared.onAppStateChanged = { [weak self] active in
            self?.emit(.appStateChanged, ["state": active ? "active" : "background"])
        }
        // Re-subscribe when the live client is swapped (login/register/restore).
        ObscuraSession.shared.onClientReplaced = { [weak self] client in
            self?.bindEvents(client)
        }
        bindEvents(ObscuraSession.shared.client)
    }

    deinit {
        eventTask?.cancel()
        if ObscuraBridge.shared === self {
            ObscuraBridge.shared = nil
        }
    }

    @objc override static func requiresMainQueueSetup() -> Bool { false }

    /// Single named stream; payloads are discriminated by `type`.
    override func supportedEvents() -> [String]! { ["ObscuraEvent"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Emission

    /// The single source of truth for the event *types* this bridge may emit on the
    /// `ObscuraEvent` stream. Mirrors `BridgeEvent` in Android's ObscuraBridgeModule.kt
    /// and `OBSCURA_EVENT_TYPES` in src/native/ObscuraModule.ts — the raw values MUST match.
    private enum BridgeEvent: String {
        case connectionChanged, authStateChanged, authFailed, appStateChanged
        case launchedFrom, friendsChanged, messageReceived
        case typingChanged, pushTokenReceived
    }

    /// Emit one `ObscuraEvent`. Folds `type` into the payload, matching Android's
    /// `emit(type) { … }` helper. No-ops until JS has a listener attached.
    private func emit(_ event: BridgeEvent, _ fields: [String: Any] = [:]) {
        guard hasListeners else { return }
        var body = fields
        body["type"] = event.rawValue
        sendEvent(withName: "ObscuraEvent", body: body)
    }

    /// Reject a promise, preferring a kit `ObscuraError`'s stable `code` over the
    /// per-method `fallbackCode` so JS can branch on *what* failed (e.g. "NOT_FRIENDS")
    /// rather than parse a message. Mirrors Android's `Promise.rejectKit`.
    func rejectKit(_ reject: @escaping RCTPromiseRejectBlock, _ fallbackCode: String, _ error: Error) {
        let code = (error as? ObscuraClient.ObscuraError)?.code ?? fallbackCode
        reject(code, error.localizedDescription, error)
    }

    // MARK: - Kit event stream -> JS

    private func bindEvents(_ client: ObscuraClient) {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await event in client.observeEvents() {
                guard let self = self else { return }
                switch event {
                case .connectionChanged(let state):
                    self.emit(.connectionChanged, ["state": state.rawValue])
                case .authChanged(let state):
                    self.emit(.authStateChanged, ["state": state.rawValue])
                case .authFailed(let reason):
                    self.emit(.authFailed, ["reason": reason])
                case .friendsChanged:
                    self.emit(.friendsChanged)
                case .messageReceived(let model):
                    // Minimal payload — JS re-queries the entry store. Don't synthesize an id.
                    self.emit(.messageReceived, ["model": model])
                case .typingChanged(let conversationId, let typers):
                    self.emit(.typingChanged, ["conversationId": conversationId, "typers": typers])
                }
            }
        }
    }

    /// `Friend` -> the `{ userId, username, status }` shape JS expects.
    static func friendDict(_ f: Friend) -> [String: Any] {
        ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
    }

    // Convenience: the live client (always non-nil — placeholder until login).
    var client: ObscuraClient { ObscuraSession.shared.client }
}

// MARK: - Auth + state reads

extension ObscuraBridge {

    @objc(registerUser:password:resolver:rejecter:)
    func registerUser(_ username: String, password: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                // Register the account, build a username-keyed encrypted DB, provision this device.
                let creds = try await ObscuraClient.registerAccount(username, password)
                let c = try ObscuraSession.shared.makeUserClient(username: username, freshDirectory: true)
                await c.restoreSession(token: creds.token, refreshToken: creds.refreshToken,
                                       userId: creds.userId, deviceId: nil, username: username)
                try await c.provisionCurrentDevice()
                ObscuraSession.shared.replaceClient(c)
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                rejectKit(reject, "REGISTER_ERROR", error)
            }
        }
    }

    @objc(login:password:resolver:rejecter:)
    func login(_ username: String, password: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                // The database is keyed by username, so the client is built before login.
                let c = try ObscuraSession.shared.makeUserClient(username: username)
                ObscuraSession.shared.replaceClient(c)
                let scenario = try await c.login(username, password)
                let mapped: String
                switch scenario {
                case .existingDevice:     mapped = "existingDevice"
                case .newDevice:          mapped = "newDevice"
                case .deviceMismatch:     mapped = "deviceMismatch"
                case .invalidCredentials: mapped = "invalidCredentials"
                }
                if scenario == .existingDevice { ObscuraSession.shared.saveSession() }
                resolve(mapped)
            } catch {
                rejectKit(reject, "LOGIN_ERROR", error)
            }
        }
    }

    @objc(loginAndProvision:password:resolver:rejecter:)
    func loginAndProvision(_ username: String, password: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await ObscuraSession.shared.client.loginAndProvision(username, password)
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                rejectKit(reject, "PROVISION_ERROR", error)
            }
        }
    }

    @objc(connect:rejecter:)
    func connect(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let c = ObscuraSession.shared.client
                _ = await c.ensureFreshToken()
                try await c.connect()
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                rejectKit(reject, "CONNECT_ERROR", error)
            }
        }
    }

    @objc(logout:rejecter:)
    func logout(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await ObscuraSession.shared.client.logout() }
            catch { ObscuraSession.shared.logger.log("logout: \(error)") }
            ObscuraSession.shared.clearSession()
            resolve(nil)
        }
    }

    @objc(wipeDevice:rejecter:)
    func wipeDevice(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await ObscuraSession.shared.client.wipeDevice()
                // The kit's wipeDevice() leaves the Keychain session; a stale one would restore the wiped device.
                ObscuraSession.shared.clearSession()
                resolve(nil)
            } catch {
                rejectKit(reject, "WIPE_ERROR", error)
            }
        }
    }

    @objc(getConnectionState:rejecter:)
    func getConnectionState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.connectionState.rawValue)
    }

    @objc(getAuthState:rejecter:)
    func getAuthState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.authState.rawValue)
    }

    @objc(getUserId:rejecter:)
    func getUserId(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.userId)
    }

    @objc(getUsername:rejecter:)
    func getUsername(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.username)
    }

    @objc(getDeviceId:rejecter:)
    func getDeviceId(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.deviceId)
    }
}

// MARK: - Friends + device linking

extension ObscuraBridge {

    /// Forget a friend: the friendship and their devices. Nothing is sent to them.
    @objc(removeFriend:resolver:rejecter:)
    func removeFriend(_ userId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.removeFriend(userId)
                resolve(nil)
            } catch {
                rejectKit(reject, "REMOVE_FRIEND_ERROR", error)
            }
        }
    }

    @objc(acceptFriend:resolver:rejecter:)
    func acceptFriend(_ userId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        NSLog("[ObscuraBridge] acceptFriend started user=%@", userId)
        Task {
            do {
                try await client.acceptFriend(userId)
                NSLog("[ObscuraBridge] acceptFriend succeeded user=%@", userId)
                resolve(nil)
            } catch {
                NSLog("[ObscuraBridge] acceptFriend failed user=%@ error=%@", userId, "\(error)")
                rejectKit(reject, "ACCEPT_ERROR", error)
            }
        }
    }

    @objc(getFriendCode:rejecter:)
    func getFriendCode(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let code = client.friendCode() else {
            reject("FRIEND_CODE_ERROR", "no friend code available (not authenticated?)", nil); return
        }
        resolve(code)
    }

    @objc(addFriendByCode:resolver:rejecter:)
    func addFriendByCode(_ code: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.addFriendByCode(code); resolve(nil) }
            catch { rejectKit(reject, "ADD_FRIEND_ERROR", error) }
        }
    }

    @objc(getFriends:rejecter:)
    func getFriends(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            let all = await client.getFriends()
            resolve(all.map { ObscuraBridge.friendDict($0) })
        }
    }

    @objc(generateLinkCode:rejecter:)
    func generateLinkCode(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let code = client.generateLinkCode() else {
            reject("LINK_CODE_ERROR", "could not generate link code", nil); return
        }
        resolve(code)
    }

    @objc(validateAndApproveLink:resolver:rejecter:)
    func validateAndApproveLink(_ code: String,
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.validateAndApproveLink(code); resolve(nil) }
            catch { rejectKit(reject, "LINK_APPROVE_ERROR", error) }
        }
    }
}

// MARK: - Kit data surface

extension ObscuraBridge {

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // Kit data surface.
    //
    // Drain the inbox, store application entries, and send application writes.
    // Payload data crosses as an opaque JSON string and is never re-encoded.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    @objc(inboxPeek:resolver:rejecter:)
    func inboxPeek(_ limit: NSNumber,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let rows = try await client.inbox.peek(limit: limit.intValue)
                resolve(rows.map { ObscuraBridge.inboxRowDict($0) })
            } catch {
                rejectKit(reject, "INBOX_PEEK_ERROR", error)
            }
        }
    }

    @objc(inboxConsume:resolver:rejecter:)
    func inboxConsume(_ ids: [NSNumber],
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.inbox.consume(ids.map { $0.int64Value })
                resolve(nil)
            } catch {
                rejectKit(reject, "INBOX_CONSUME_ERROR", error)
            }
        }
    }

    /// Permanent data loss; the kit logs `reason` as a security event, so it is required.
    @objc(inboxDiscard:reason:resolver:rejecter:)
    func inboxDiscard(_ ids: [NSNumber], reason: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.inbox.discard(ids.map { $0.int64Value }, reason: reason)
                resolve(nil)
            } catch {
                rejectKit(reject, "INBOX_DISCARD_ERROR", error)
            }
        }
    }

    @objc(inboxDepth:rejecter:)
    func inboxDepth(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.inbox.depth())
            } catch {
                rejectKit(reject, "INBOX_DEPTH_ERROR", error)
            }
        }
    }

    @objc(entryPut:id:dataJson:sentAt:authorDeviceId:localMetadataJson:resolver:rejecter:)
    func entryPut(_ model: String, id: String, dataJson: String, sentAt: NSNumber,
                  authorDeviceId: String, localMetadataJson: String?,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.entries.put(model: model, entry: StoredEntry(
                    id: id, data: dataJson,
                    sentAt: sentAt.uint64Value, authorDeviceId: authorDeviceId,
                    localMetadata: localMetadataJson
                ))
                resolve(nil)
            } catch {
                rejectKit(reject, "ENTRY_PUT_ERROR", error)
            }
        }
    }

    /// Securely remove local entries. The app decides when.
    @objc(entryErase:ids:resolver:rejecter:)
    func entryErase(_ model: String, ids: [String],
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.entries.erase(model: model, ids: ids)
                resolve(nil)
            } catch {
                rejectKit(reject, "ENTRY_ERASE_ERROR", error)
            }
        }
    }

    /// The named entries that exist.
    @objc(entryGet:ids:resolver:rejecter:)
    func entryGet(_ model: String, ids: [String],
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.entries.get(model: model, ids: ids).map(ObscuraBridge.entryDict))
            } catch {
                rejectKit(reject, "ENTRY_GET_ERROR", error)
            }
        }
    }

    @objc(entryAll:resolver:rejecter:)
    func entryAll(_ model: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.entries.all(model: model).map(ObscuraBridge.entryDict))
            } catch {
                rejectKit(reject, "ENTRY_ALL_ERROR", error)
            }
        }
    }

    static func entryDict(_ e: StoredEntry) -> [String: Any] {
        ["id": e.id, "data": e.data, "sentAt": Double(e.sentAt), "authorDeviceId": e.authorDeviceId,
         "localMetadata": e.localMetadata as Any]
    }

    /// Per-device results: `{userId, deviceId, status, error}`, status `accepted|rejected|unknown`.
    static func sendReportDict(_ r: SendReport) -> [String: Any] {
        func results(_ list: [SubmissionResult]) -> [[String: Any]] {
            list.map { ["userId": $0.userId, "deviceId": $0.deviceId as Any, "status": $0.status.rawValue,
                        "error": $0.error as Any] }
        }
        return ["recipients": results(r.recipients), "selfSync": results(r.selfSync)]
    }

    /// The caller names recipients; the kit resolves no audience.
    @objc(sendEntry:modelKey:entryId:sentAt:payloadJson:resolver:rejecter:)
    func sendEntry(_ recipientUserIds: [String], modelKey: String, entryId: String,
                   sentAt: NSNumber, payloadJson: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let report = try await client.send(
                    to: recipientUserIds, modelKey: modelKey, entryId: entryId,
                    sentAt: sentAt.uint64Value, payload: Data(payloadJson.utf8)
                )
                resolve(ObscuraBridge.sendReportDict(report))
            } catch {
                rejectKit(reject, "SEND_ERROR", error)
            }
        }
    }

    /// `payload` crosses as a UTF-8 string. For an unknown `kind` the decoding is lossy, which is
    /// safe because the app discards such rows without reading the payload.
    static func inboxRowDict(_ r: InboxRecord) -> [String: Any] {
        [
            "id": Double(r.id),
            "kind": r.kind,
            "senderUserId": r.senderUserId,
            "senderDeviceId": r.senderDeviceId as Any,
            "modelKey": r.modelKey as Any,
            "entryId": r.entryId as Any,
            "sentAt": r.sentAt.map { Double($0) } as Any,
            "payload": String(decoding: r.payload, as: UTF8.self),
        ]
    }

}

// MARK: - Typing signals

extension ObscuraBridge {

    @objc(sendTyping:conversationId:resolver:rejecter:)
    func sendTyping(_ recipientUserIds: [String], conversationId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await client.sendTyping(to: recipientUserIds, contextId: conversationId, state: .started)
            resolve(nil)
        }
    }

    @objc(stopTyping:conversationId:resolver:rejecter:)
    func stopTyping(_ recipientUserIds: [String], conversationId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await client.sendTyping(to: recipientUserIds, contextId: conversationId, state: .stopped)
            resolve(nil)
        }
    }

    @objc(observeTyping:resolver:rejecter:)
    func observeTyping(_ conversationId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        typingTasks[conversationId]?.cancel()
        let observation = client.observeTyping(contextId: conversationId)
        typingTasks[conversationId] = Task { [weak self] in
            for await userIds in observation.values {
                self?.emit(.typingChanged, ["conversationId": conversationId, "userIds": userIds])
            }
        }
        resolve(nil)
    }

    @objc(stopObservingTyping:resolver:rejecter:)
    func stopObservingTyping(_ conversationId: String,
                             resolver resolve: RCTPromiseResolveBlock,
                             rejecter reject: RCTPromiseRejectBlock) {
        typingTasks[conversationId]?.cancel()
        typingTasks[conversationId] = nil
        resolve(nil)
    }
}

// MARK: - Attachments
//
// Bytes never cross the bridge: upload reads a file path, download decrypts to
// a cache file and returns its path. Mirrors ObscuraBridgeModule.kt.

extension ObscuraBridge {

    private static let safeIdChars = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    private static let attachmentExtensions = ["jpg", "mp4", "mov"]

    private static func attachmentDir() -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("attachments")
    }

    /// Cache file stem for an attachment id. Ids come from the server, so never trust them as a path.
    private static func attachmentStem(_ id: String) -> String {
        String(String.UnicodeScalarView(id.unicodeScalars.map { safeIdChars.contains($0) ? $0 : "_" }))
    }

    @objc(uploadAttachment:resolver:rejecter:)
    func uploadAttachment(_ filePath: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
                // The kit encrypts + uploads and returns the reference triple.
                let result = try await client.uploadAttachment(data)
                resolve([
                    "id": result.id,
                    "contentKey": result.contentKey.base64EncodedString(),
                    "nonce": result.nonce.base64EncodedString(),
                ])
            } catch {
                rejectKit(reject, "UPLOAD_ERROR", error)
            }
        }
    }

    @objc(downloadAttachment:contentKey:nonce:resolver:rejecter:)
    func downloadAttachment(_ id: String, contentKey: String, nonce: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let fm = FileManager.default
                let dir = ObscuraBridge.attachmentDir()
                try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

                let safe = ObscuraBridge.attachmentStem(id)
                for ext in ObscuraBridge.attachmentExtensions {
                    let c = dir.appendingPathComponent("\(safe).\(ext)")
                    if fm.fileExists(atPath: c.path),
                       let attrs = try? fm.attributesOfItem(atPath: c.path),
                       let sz = attrs[.size] as? Int, sz > 0 {
                        resolve(c.path); return
                    }
                }

                guard let keyData = Data(base64Encoded: contentKey),
                      let nonceData = Data(base64Encoded: nonce) else {
                    reject("DOWNLOAD_ERROR", "invalid base64 key/nonce", nil); return
                }
                let data = try await client.downloadDecryptedAttachment(
                    id: id, contentKey: keyData, nonce: nonceData)

                // Pick the extension from the content so players that key off it
                // (AVPlayer / ExoPlayer) can decode. Video is ISO-BMFF with an
                // "ftyp" box at offset 4; brand "qt  " => QuickTime .mov.
                var ext = "jpg"
                let head = [UInt8](data.prefix(12))
                if head.count >= 12, head[4] == 0x66, head[5] == 0x74, head[6] == 0x79, head[7] == 0x70 {
                    let brand = String(bytes: head[8..<12], encoding: .ascii) ?? ""
                    ext = brand == "qt  " ? "mov" : "mp4"
                }
                let dest = dir.appendingPathComponent("\(safe).\(ext)")

                // Atomic publish: write a sibling temp, then rename into place.
                let tmp = dir.appendingPathComponent("\(safe).\(ext).tmp")
                try data.write(to: tmp, options: .atomic)
                if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: dest) }
                try fm.moveItem(at: tmp, to: dest)
                resolve(dest.path)
            } catch {
                rejectKit(reject, "DOWNLOAD_ERROR", error)
            }
        }
    }

    /// Delete this device's decrypted copy of an attachment. The server's ciphertext is untouched.
    @objc(purgeAttachment:resolver:rejecter:)
    func purgeAttachment(_ id: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        let dir = ObscuraBridge.attachmentDir()
        let stem = ObscuraBridge.attachmentStem(id)
        for ext in ObscuraBridge.attachmentExtensions {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(stem).\(ext)"))
            try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(stem).\(ext).tmp"))
        }
        resolve(nil)
    }
}

// MARK: - Image processing — pure native, path-in/path-out

extension ObscuraBridge {

    private static func outputImageURL() -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("processed")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(UUID().uuidString).jpg")
    }

    /// Re-encode the image at `srcPath` as JPEG so its largest side is ≤ `maxDim`.
    /// EXIF orientation is baked into the output (ThumbnailWithTransform); peak
    /// memory is bounded by ImageIO's thumbnail decode. Source is untouched.
    @objc(resizeImage:maxDim:quality:resolver:rejecter:)
    func resizeImage(_ srcPath: String, maxDim: NSInteger, quality: NSInteger,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard maxDim > 0 else { reject("RESIZE_ERROR", "maxDim must be > 0", nil); return }
        let q = max(1, min(100, quality))
        Task.detached {
            let srcURL = URL(fileURLWithPath: srcPath)
            guard let src = CGImageSourceCreateWithURL(srcURL as CFURL, nil) else {
                reject("RESIZE_ERROR", "cannot read image at \(srcPath)", nil); return
            }
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxDim,
                kCGImageSourceCreateThumbnailWithTransform: true, // bake EXIF orientation
            ]
            guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
                reject("RESIZE_ERROR", "resize failed (corrupt or out of memory)", nil); return
            }
            let outURL = ObscuraBridge.outputImageURL()
            guard let dest = CGImageDestinationCreateWithURL(
                outURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                reject("RESIZE_ERROR", "cannot create JPEG destination", nil); return
            }
            CGImageDestinationAddImage(dest, thumb, [
                kCGImageDestinationLossyCompressionQuality: Double(q) / 100.0
            ] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else {
                reject("RESIZE_ERROR", "failed to encode JPEG", nil); return
            }
            resolve(["path": outURL.path, "width": thumb.width, "height": thumb.height])
        }
    }

    /// Generate a simple test image (emulator / no-camera fallback in CameraScreen).
    @objc(writeTestImage:height:resolver:rejecter:)
    func writeTestImage(_ width: NSInteger, height: NSInteger,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard width > 0, height > 0, width <= 8192, height <= 8192 else {
            reject("TEST_IMAGE_ERROR", "invalid dimensions", nil); return
        }
        let size = CGSize(width: width, height: height)
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.systemIndigo.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            UIColor.white.setStroke()
            let path = UIBezierPath()
            path.move(to: .zero)
            path.addLine(to: CGPoint(x: size.width, y: size.height))
            path.lineWidth = 4
            path.stroke()
        }
        guard let data = img.jpegData(compressionQuality: 0.9) else {
            reject("TEST_IMAGE_ERROR", "failed to encode test image", nil); return
        }
        let outURL = ObscuraBridge.outputImageURL()
        do {
            try data.write(to: outURL, options: .atomic)
            resolve(["path": outURL.path, "width": width, "height": height])
        } catch {
            rejectKit(reject, "TEST_IMAGE_ERROR", error)
        }
    }
}

// MARK: - Misc

extension ObscuraBridge {

    @objc(setClipboard:resolver:rejecter:)
    func setClipboard(_ text: String,
                      resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        UIPasteboard.general.string = text
        resolve(nil)
    }

    /// Best-effort delete — a missing file resolves (does not reject), per BRIDGE.md.
    @objc(deleteFile:resolver:rejecter:)
    func deleteFile(_ path: String,
                    resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        try? FileManager.default.removeItem(atPath: path)
        resolve(nil)
    }

    /// Spin up the audio HAL ahead of recording. Cold `AVAudioSession` activation
    /// costs ~1.4s (it negotiates the category + powers the mic hardware); doing
    /// it once when the camera screen appears makes VisionCamera's per-record
    /// activation effectively instant. Idempotent + cheap to call repeatedly.
    @objc(prewarmAudioSession:rejecter:)
    func prewarmAudioSession(_ resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .videoRecording,
                                         options: [.defaultToSpeaker, .allowBluetooth])
                try session.setActive(true)
                resolve(nil)
            } catch {
                self.rejectKit(reject, "PREWARM_ERROR", error)
            }
        }
    }
}

// MARK: - Push permission + kit token registration
//
// Permission requests and kit token registration are implemented. APNs/FCM
// token delivery is not wired to `pushTokenReceived`, so iOS push is not active.

extension ObscuraBridge {

    @objc(requestPushPermission:rejecter:)
    func requestPushPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                self.rejectKit(reject, "PUSH_PERMISSION_ERROR", error); return
            }
            // Only request an APNs token after notification permission is granted.
            if granted {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            resolve(granted)
        }
    }

    @objc(registerPushToken:resolver:rejecter:)
    func registerPushToken(_ token: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.registerPushToken(token); resolve(nil) }
            catch { rejectKit(reject, "REGISTER_TOKEN_ERROR", error) }
        }
    }
}

// MARK: - Deep linking + debug log
//
// appStateChanged is already wired in init() via ObscuraSession.onAppStateChanged.
// Cold-start deep links arrive via getLaunchIntent (consume-once); warm-start taps
// via the launchedFrom event. Notification callbacks are not wired, so
// getLaunchIntent currently returns nil.

extension ObscuraBridge {

    /// Returns the cold-start deep-link target once, then nil. Called once on mount.
    @objc(getLaunchIntent:rejecter:)
    func getLaunchIntent(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        if let screen = ObscuraBridge.pendingLaunchScreen {
            ObscuraBridge.pendingLaunchScreen = nil
            resolve(["screen": screen])
        } else {
            resolve(nil)
        }
    }

    @objc(getDebugLog:rejecter:)
    func getDebugLog(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.getDebugLog())
    }

    /// Called from AppDelegate when a warm-start deep link arrives (notification
    /// tapped while running). Cold starts use `getLaunchIntent` instead.
    static func deliverLaunchedFrom(_ screen: String) {
        shared?.emit(.launchedFrom, ["screen": screen])
    }
}
