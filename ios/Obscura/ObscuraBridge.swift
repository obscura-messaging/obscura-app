import Foundation
import React
import ObscuraKit
import AVFoundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
import UserNotifications

@MainActor
@objc(ObscuraBridge)
final class ObscuraBridge: RCTEventEmitter {
    private static weak var shared: ObscuraBridge?

    private var hasListeners = false
    private var authenticating = false
    private var eventTasks: [Task<Void, Never>] = []
    /// Active typing observations, keyed by conversationId.
    private var typingTasks: [String: Task<Void, Never>] = [:]

    /// The link this device is waiting on. Its secrets never cross to JS, which holds only the code.
    private struct PendingLink {
        let client: ObscuraClient
        let request: LinkRequest
    }
    private var pendingLink: PendingLink?
    private var linkTask: Task<Void, Never>?

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
        ObscuraSession.shared.onMessageReceived = { [weak self] model in
            self?.emit(.messageReceived, ["model": model])
        }
        // Re-subscribe when the live client is swapped (login/register/restore).
        ObscuraSession.shared.onClientReplaced = { [weak self] client in
            self?.bindEvents(client)
        }
        bindEvents(ObscuraSession.shared.client)
    }

    deinit {
        eventTasks.forEach { $0.cancel() }
        typingTasks.values.forEach { $0.cancel() }
    }

    @objc nonisolated override static func requiresMainQueueSetup() -> Bool { true }
    @objc override var methodQueue: DispatchQueue! { .main }

    /// Single named stream; payloads are discriminated by `type`.
    override func supportedEvents() -> [String]! { ["ObscuraEvent"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Emission

    /// Matches the event union in `src/native/ObscuraModule.ts`.
    private enum BridgeEvent: String {
        case connectionChanged, authStateChanged, appStateChanged
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
    nonisolated func rejectKit(_ reject: @escaping RCTPromiseRejectBlock, _ fallbackCode: String, _ error: Error) {
        let code = (error as? ObscuraError)?.code ?? fallbackCode
        reject(code, error.localizedDescription, error)
    }

    // MARK: - Kit event stream -> JS

    private func bindEvents(_ client: ObscuraClient?) {
        eventTasks.forEach { $0.cancel() }
        eventTasks = []
        typingTasks.values.forEach { $0.cancel() }
        typingTasks = [:]
        guard let client else {
            emit(.authStateChanged, ["state": "loggedOut"])
            emit(.connectionChanged, ["state": "disconnected"])
            return
        }
        eventTasks = [
            Task { [weak self] in
                for await state in client.observeConnectionState() {
                    self?.emit(.connectionChanged, ["state": state.rawValue])
                }
            },
            Task { [weak self] in
                for await state in client.observeAuthState() {
                    self?.emit(.authStateChanged, ["state": state.rawValue])
                }
            },
            Task { [weak self] in
                for await _ in client.observeFriendsChanged() { self?.emit(.friendsChanged) }
            },
        ]
    }

    /// `Friend` -> the `{ userId, username, status }` shape JS expects.
    static func friendDict(_ f: Friend) -> [String: Any] {
        ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
    }

    var client: ObscuraClient {
        get async throws { try await ObscuraSession.shared.readyClient() }
    }

    @discardableResult
    private func authenticate(_ resolve: @escaping RCTPromiseResolveBlock,
                              _ reject: @escaping RCTPromiseRejectBlock,
                              _ code: String, _ operation: @escaping () async throws -> Any?) -> Task<Void, Never>? {
        guard !authenticating else {
            rejectKit(reject, code, ObscuraError.invalidArgument("Authentication already in progress"))
            return nil
        }
        authenticating = true
        return Task {
            defer { authenticating = false }
            do { resolve(try await operation()) }
            catch where Task.isCancelled { reject("CANCELLED", "Cancelled", error) }
            catch { rejectKit(reject, code, error) }
        }
    }
}

// MARK: - Auth + state reads

extension ObscuraBridge {

    @objc(registerUser:password:resolver:rejecter:)
    func registerUser(_ username: String, password: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "REGISTER_ERROR") {
            let c = try ObscuraSession.shared.makeUserClient(username: username)
            try await ObscuraSession.shared.replaceClient(c, username: username)
            try await c.register(username, password)
            return nil
        }
    }

    @objc(login:password:resolver:rejecter:)
    func login(_ username: String, password: String,
               resolver resolve: @escaping RCTPromiseResolveBlock,
               rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "LOGIN_ERROR") {
            let c = try ObscuraSession.shared.makeUserClient(username: username)
            try await ObscuraSession.shared.replaceClient(c, username: username)
            switch try await c.login(username, password) {
            case .existingDevice: return "existingDevice"
            case .linkRequired: return "linkRequired"
            case .deviceMismatch: return "deviceMismatch"
            case .invalidCredentials: return "invalidCredentials"
            }
        }
    }

    @objc(resetAccount:password:resolver:rejecter:)
    func resetAccount(_ username: String, password: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "RESET_ERROR") {
            let c = try ObscuraSession.shared.makeUserClient(username: username)
            try await ObscuraSession.shared.replaceClient(c, username: username)
            try await c.resetAccount(username, password)
            return nil
        }
    }

    @objc(beginLink:password:resolver:rejecter:)
    func beginLink(_ username: String, password: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
        pendingLink = nil
        linkTask = authenticate(resolve, reject, "LINK_ERROR") {
            let c = try await ObscuraSession.shared.reuseOrReplaceClient(username: username)
            let request = try await c.beginLink(username, password, deviceName: ObscuraSession.shared.deviceName)
            self.pendingLink = PendingLink(client: c, request: request)
            return request.code
        }
    }

    /// Cancellable with `cancelLink`; the kit bounds the wait by the link session's expiry.
    @objc(completeLink:rejecter:)
    func completeLink(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        let pending = pendingLink
        pendingLink = nil
        guard let pending, pending.client === ObscuraSession.shared.client else {
            rejectKit(reject, "LINK_ERROR", ObscuraError.invalidArgument("No link in progress"))
            return
        }
        linkTask = authenticate(resolve, reject, "LINK_ERROR") {
            try await pending.client.completeLink(pending.request)
            return nil
        }
    }

    /// Resolves once a waiting `completeLink` has settled, so the next auth call does not race it.
    @objc(cancelLink:rejecter:)
    func cancelLink(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        pendingLink = nil
        let task = linkTask
        linkTask = nil
        task?.cancel()
        Task {
            await task?.value
            resolve(nil)
        }
    }

    @objc(connect:rejecter:)
    func connect(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.connect()
                resolve(nil)
            } catch {
                rejectKit(reject, "CONNECT_ERROR", error)
            }
        }
    }

    @objc(logout:rejecter:)
    func logout(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "LOGOUT_ERROR") {
            await ObscuraSession.shared.waitForRestore()
            if let c = ObscuraSession.shared.client { try await c.logout() }
            ObscuraSession.shared.discardClient()
            return nil
        }
    }

    @objc(wipeDevice:rejecter:)
    func wipeDevice(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "WIPE_ERROR") {
            try await self.client.wipeDevice()
            ObscuraSession.shared.discardClient()
            return nil
        }
    }

    @objc(getConnectionState:rejecter:)
    func getConnectionState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            resolve(ObscuraSession.shared.client?.connectionState.rawValue ?? "disconnected")
        }
    }

    @objc(getAuthState:rejecter:)
    func getAuthState(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            resolve(ObscuraSession.shared.client?.authState.rawValue ?? "loggedOut")
        }
    }

    @objc(getUserId:rejecter:)
    func getUserId(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            resolve(await ObscuraSession.shared.client?.userId)
        }
    }

    @objc(getUsername:rejecter:)
    func getUsername(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            resolve(await ObscuraSession.shared.client?.username)
        }
    }

    @objc(getDeviceId:rejecter:)
    func getDeviceId(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            resolve(await ObscuraSession.shared.client?.deviceId)
        }
    }

    @objc(isPrimary:rejecter:)
    func isPrimary(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await ObscuraSession.shared.waitForRestore()
            do { resolve(try await ObscuraSession.shared.client?.isPrimary ?? false) }
            catch { rejectKit(reject, "IS_PRIMARY_ERROR", error) }
        }
    }
}

// MARK: - Devices

extension ObscuraBridge {

    @objc(linkCodeDeviceName:resolver:rejecter:)
    func linkCodeDeviceName(_ code: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        do { resolve(try ObscuraClient.linkCodeDeviceName(code)) }
        catch { rejectKit(reject, "LINK_CODE_ERROR", error) }
    }

    @objc(approveLink:resolver:rejecter:)
    func approveLink(_ code: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.approveLink(code); resolve(nil) }
            catch { rejectKit(reject, "APPROVE_LINK_ERROR", error) }
        }
    }

    @objc(getDevices:rejecter:)
    func getDevices(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.devices().map {
                    ["deviceId": $0.deviceId, "name": $0.name as Any, "isPrimary": $0.isPrimary,
                     "isThisDevice": $0.isThisDevice]
                })
            } catch {
                rejectKit(reject, "GET_DEVICES_ERROR", error)
            }
        }
    }

    /// Unlinking this device wipes it, so the host releases the client as `wipeDevice` does.
    @objc(unlinkDevice:resolver:rejecter:)
    func unlinkDevice(_ deviceId: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        authenticate(resolve, reject, "UNLINK_ERROR") {
            let c = try await self.client
            let isThisDevice = await c.deviceId == deviceId
            try await c.unlinkDevice(deviceId)
            if isThisDevice { ObscuraSession.shared.discardClient() }
            return nil
        }
    }
}

// MARK: - Friends

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
        Task {
            do {
                try await client.acceptFriend(userId)
                resolve(nil)
            } catch {
                rejectKit(reject, "ACCEPT_ERROR", error)
            }
        }
    }

    @objc(getFriendCode:rejecter:)
    func getFriendCode(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { resolve(try await client.friendCode()) }
            catch { rejectKit(reject, "FRIEND_CODE_ERROR", error) }
        }
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
            do {
                let all = try await ObscuraSession.shared.client?.getFriends() ?? []
                resolve(all.map { ObscuraBridge.friendDict($0) })
            } catch {
                rejectKit(reject, "GET_FRIENDS_ERROR", error)
            }
        }
    }
}

// MARK: - Kit data surface

extension ObscuraBridge {

    @objc(getMessages:rejecter:)
    func getMessages(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let items = try await client.getMessages()
                resolve(items.map(ObscuraBridge.conversationItemDict))
            } catch {
                rejectKit(reject, "GET_MESSAGES_ERROR", error)
            }
        }
    }

    @objc(sendMessage:content:resolver:rejecter:)
    func sendMessage(_ peerUserId: String, content: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.sendMessage(peerUserId: peerUserId, content: content))
            } catch {
                rejectKit(reject, "SEND_MESSAGE_ERROR", error)
            }
        }
    }

    @objc(markSeen:resolver:rejecter:)
    func markSeen(_ entryId: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.markSeen(entryId: entryId)
                resolve(nil)
            } catch {
                rejectKit(reject, "MARK_SEEN_ERROR", error)
            }
        }
    }

    @objc(getStories:rejecter:)
    func getStories(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let items = try await client.getStories()
                resolve(items.map(ObscuraBridge.storyItemDict))
            } catch {
                rejectKit(reject, "GET_STORIES_ERROR", error)
            }
        }
    }

    @objc(getProfiles:rejecter:)
    func getProfiles(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let items = try await client.getProfiles()
                resolve(items.map(ObscuraBridge.profileItemDict))
            } catch {
                rejectKit(reject, "GET_PROFILES_ERROR", error)
            }
        }
    }

    @objc(updateProfile:bio:resolver:rejecter:)
    func updateProfile(_ displayName: String, bio: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.updateProfile(displayName: displayName, bio: bio)
                resolve(nil)
            } catch {
                rejectKit(reject, "UPDATE_PROFILE_ERROR", error)
            }
        }
    }

    @objc(flushOutbox:rejecter:)
    func flushOutbox(_ resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.flushOutbox())
            } catch {
                rejectKit(reject, "FLUSH_OUTBOX_ERROR", error)
            }
        }
    }

    @objc(sweepExpired:rejecter:)
    func sweepExpired(_ resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let touched = try await client.sweepExpired()
                resolve(Array(touched))
            } catch {
                rejectKit(reject, "SWEEP_EXPIRED_ERROR", error)
            }
        }
    }

    static func attachmentDict(_ att: MediaAttachment) -> [String: Any] {
        [
            "id": att.id,
            "mediaType": att.mediaType,
        ]
    }

    static func conversationItemDict(_ item: ConversationItem) -> [String: Any] {
        if item.kind == "pix", let att = item.attachment {
            return [
                "id": item.id,
                "peerUserId": item.peerUserId,
                "kind": "pix",
                "authorUserId": item.authorUserId,
                "sentAt": Double(item.sentAt),
                "viewedAt": item.viewedAt.map { Double($0) } as Any,
                "content": item.content,
                "attachment": attachmentDict(att),
                "caption": item.caption as Any,
                "captionMeta": item.captionMeta as Any,
                "displayDuration": item.displayDuration,
            ]
        }
        return [
            "id": item.id,
            "peerUserId": item.peerUserId,
            "kind": "message",
            "authorUserId": item.authorUserId,
            "sentAt": Double(item.sentAt),
            "viewedAt": item.viewedAt.map { Double($0) } as Any,
            "content": item.content,
        ]
    }

    static func storyItemDict(_ item: StoryItem) -> [String: Any] {
        [
            "id": item.id,
            "authorUserId": item.authorUserId,
            "sentAt": Double(item.sentAt),
            "content": item.content,
            "attachment": item.attachment.map(attachmentDict) as Any,
            "captionMeta": item.captionMeta as Any,
        ]
    }

    static func profileItemDict(_ item: ProfileItem) -> [String: Any] {
        [
            "userId": item.userId,
            "authorDeviceId": item.authorDeviceId,
            "updatedAt": Double(item.updatedAt),
            "displayName": item.displayName,
            "bio": item.bio,
        ]
    }
}

// MARK: - Typing signals

extension ObscuraBridge {

    @objc(sendTyping:resolver:rejecter:)
    func sendTyping(_ peerUserId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.sendTyping(peerUserId: peerUserId, state: .started)
                resolve(nil)
            } catch {
                rejectKit(reject, "TYPING_ERROR", error)
            }
        }
    }

    @objc(stopTyping:resolver:rejecter:)
    func stopTyping(_ peerUserId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await client.sendTyping(peerUserId: peerUserId, state: .stopped)
                resolve(nil)
            } catch {
                rejectKit(reject, "STOP_TYPING_ERROR", error)
            }
        }
    }

    @objc(observeTyping:resolver:rejecter:)
    func observeTyping(_ peerUserId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        typingTasks[peerUserId]?.cancel()
        typingTasks[peerUserId] = Task { [weak self] in
            let observation: AsyncStream<Bool>
            do {
                guard let self else { return }
                observation = try await self.client.observePeerTyping(peerUserId)
                guard !Task.isCancelled else {
                    resolve(nil)
                    return
                }
                resolve(nil)
            } catch {
                self?.typingTasks[peerUserId] = nil
                self?.rejectKit(reject, "OBSERVE_TYPING_ERROR", error)
                return
            }
            for await isTyping in observation {
                guard !Task.isCancelled else { break }
                self?.emit(.typingChanged, ["peerUserId": peerUserId, "typing": isTyping])
            }
        }
    }

    @objc(stopObservingTyping:resolver:rejecter:)
    func stopObservingTyping(_ peerUserId: String,
                             resolver resolve: RCTPromiseResolveBlock,
                             rejecter reject: RCTPromiseRejectBlock) {
        typingTasks[peerUserId]?.cancel()
        typingTasks[peerUserId] = nil
        resolve(nil)
    }
}

// MARK: - Attachments
//
// Bytes and key material never cross the bridge: the kit uploads from a file path and keeps the
// keys, and download decrypts an entry's attachment to a cache file and returns its path. Mirrors
// ObscuraBridgeModule.kt.

extension ObscuraBridge {

    @objc(sendCapture:resolver:rejecter:)
    func sendCapture(_ capture: NSDictionary,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        let path = capture["path"] as? String ?? ""
        let mediaType = capture["mediaType"] as? String ?? "photo"
        let caption = capture["caption"] as? String ?? ""
        let captionMeta = capture["captionMeta"] as? String
        let displayDuration = (capture["displayDuration"] as? NSNumber)?.intValue ?? 0
        let recipients = capture["recipientUserIds"] as? [String] ?? []
        let toStory = (capture["toStory"] as? NSNumber)?.boolValue ?? false
        Task {
            do {
                let result = try await client.sendCapture(
                    filePath: path, mediaType: mediaType, caption: caption, captionMeta: captionMeta,
                    displayDuration: displayDuration, peerUserIds: recipients, toStory: toStory
                )
                resolve([
                    "undeliveredUserIds": result.undeliveredPeerUserIds,
                    "storyUndelivered": result.storyUndelivered,
                ])
            } catch {
                rejectKit(reject, "SEND_CAPTURE_ERROR", error)
            }
        }
    }

    @objc(downloadAttachment:resolver:rejecter:)
    func downloadAttachment(_ entryId: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                resolve(try await client.downloadAttachmentToCache(entryId: entryId))
            } catch {
                rejectKit(reject, "DOWNLOAD_ERROR", error)
            }
        }
    }
}

// MARK: - Image processing — pure native, path-in/path-out

extension ObscuraBridge {

    nonisolated private static func outputImageURL() -> URL {
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
        resolve(ObscuraSession.shared.client?.getDebugLog() ?? [])
    }

    /// Called from AppDelegate when a warm-start deep link arrives (notification
    /// tapped while running). Cold starts use `getLaunchIntent` instead.
    static func deliverLaunchedFrom(_ screen: String) {
        shared?.emit(.launchedFrom, ["screen": screen])
    }
}
