import Foundation

extension ObscuraClient {
    // MARK: - Content & Messaging

    static func nowMs() -> UInt64 {
        UInt64(Date().timeIntervalSince1970 * 1000)
    }

    static func generateId(prefix: String) -> String {
        let rand = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(8)
        return "\(prefix)_\(nowMs())_\(rand)"
    }

    public func getMessages() async throws -> [ConversationItem] {
        try await content.messages()
    }

    public func sendMessage(peerUserId: String, content text: String) async throws -> String {
        guard !peerUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("peerUserId must not be blank")
        }
        let (selfUserId, _) = try await sendContext()
        guard peerUserId != selfUserId else {
            throw ObscuraError.invalidArgument("cannot message yourself")
        }
        let sentAt = Self.nowMs()
        let id = Self.generateId(prefix: "dm")
        let item = ConversationItem.message(
            id: id,
            peerUserId: peerUserId,
            authorUserId: selfUserId,
            sentAt: sentAt,
            content: text
        )
        try await content.insertConversationItem(item, undelivered: false)
        let isAccepted = try await friends.friend(peerUserId)?.status == .accepted
        try await deliverOrQueue(
            item.toClientMessage(),
            to: isAccepted ? [peerUserId] : [],
            requireRecipient: true,
            failureReason: "directMessage to \(peerUserId) reached no recipient devices",
            markUndelivered: { try? await self.content.setMessageUndelivered(id: id, undelivered: true) }
        )
        return id
    }

    public func sendPix(
        peerUserId: String,
        mediaRef: String,
        contentKey: String,
        nonce: String,
        mediaType: String,
        caption: String,
        captionMeta: String?,
        displayDuration: Int
    ) async throws -> String {
        guard !peerUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("peerUserId must not be blank")
        }
        guard !mediaRef.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let keyBytes = Data(base64Encoded: contentKey), !keyBytes.isEmpty,
              let nonceBytes = Data(base64Encoded: nonce), !nonceBytes.isEmpty else {
            throw ObscuraError.invalidArgument("invalid pix attachment reference or key material")
        }
        let (selfUserId, _) = try await sendContext()
        guard peerUserId != selfUserId else {
            throw ObscuraError.invalidArgument("cannot message yourself")
        }
        let sentAt = Self.nowMs()
        let id = Self.generateId(prefix: "pix")
        let attachment = MediaAttachment(
            id: mediaRef,
            contentKey: keyBytes,
            nonce: nonceBytes,
            mediaType: mediaType
        )
        let item = ConversationItem.pix(
            id: id,
            peerUserId: peerUserId,
            authorUserId: selfUserId,
            sentAt: sentAt,
            attachment: attachment,
            caption: caption,
            captionMeta: captionMeta,
            displayDuration: displayDuration
        )
        try await content.insertConversationItem(item, undelivered: false)
        let isAccepted = try await friends.friend(peerUserId)?.status == .accepted
        try await deliverOrQueue(
            item.toClientMessage(),
            to: isAccepted ? [peerUserId] : [],
            requireRecipient: true,
            failureReason: "pix to \(peerUserId) reached no recipient devices",
            markUndelivered: { try? await self.content.setMessageUndelivered(id: id, undelivered: true) }
        )
        return id
    }

    public func markSeen(entryId: String) async throws {
        guard !entryId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("entryId must not be blank")
        }
        let (selfUserId, _) = try await sendContext()
        let now = Self.nowMs()
        guard let updated = try await content.markSeenLocal(entryId: entryId, selfUserId: selfUserId, viewedAt: now) else {
            return
        }
        let isAccepted = try await friends.friend(updated.peerUserId)?.status == .accepted
        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = now
        message.seenReceipt.entryID = entryId
        message.seenReceipt.peerUserID = updated.peerUserId
        message.seenReceipt.viewedAt = now
        _ = try await send(message, to: isAccepted ? [updated.peerUserId] : [])
    }

    public func getStories(now: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)) async throws -> [StoryItem] {
        try await content.stories(now: now)
    }

    public func postStory(
        content text: String,
        mediaRef: String?,
        contentKey: String?,
        nonce: String?,
        mediaType: String?,
        captionMeta: String?
    ) async throws -> String {
        let hasMedia = (mediaRef?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
        var attachment: MediaAttachment?
        if hasMedia, let mediaRef {
            guard let contentKey, let decodedKey = Data(base64Encoded: contentKey), !decodedKey.isEmpty,
                  let nonce, let decodedNonce = Data(base64Encoded: nonce), !decodedNonce.isEmpty else {
                throw ObscuraError.invalidArgument("invalid story attachment key material")
            }
            attachment = MediaAttachment(
                id: mediaRef,
                contentKey: decodedKey,
                nonce: decodedNonce,
                mediaType: mediaType ?? "photo"
            )
        }
        let (selfUserId, _) = try await sendContext()
        let sentAt = Self.nowMs()
        let id = Self.generateId(prefix: "story")
        let item = StoryItem(
            id: id,
            authorUserId: selfUserId,
            sentAt: sentAt,
            content: text,
            attachment: attachment,
            captionMeta: captionMeta
        )
        try await content.insertStoryItem(item, undelivered: false)
        let peerIds = try await friends.all().filter { $0.status == .accepted }.map(\.userId)
        try await deliverOrQueue(
            item.toClientMessage(),
            to: peerIds,
            requireRecipient: false,
            failureReason: "story reached no recipient devices",
            markUndelivered: { try? await self.content.setStoryUndelivered(id: id, undelivered: true) }
        )
        return id
    }

    public func getProfiles() async throws -> [ProfileItem] {
        try await content.profiles()
    }

    public func updateProfile(displayName: String, bio: String) async throws {
        let session = try await requireFreshSession()
        guard sender != nil else { throw ObscuraError.notAuthenticated }
        let now = Self.nowMs()
        let existing = try await content.profile(userId: session.userId)
        let sentAt = existing.map { max(now, $0.updatedAt + 1) } ?? now
        let item = ProfileItem(
            userId: session.userId,
            authorDeviceId: session.deviceId,
            updatedAt: sentAt,
            displayName: displayName,
            bio: bio
        )
        try await content.upsertProfile(item, undelivered: false)
        let peerIds = try await friends.all().filter { $0.status == .accepted }.map(\.userId)
        try await deliverOrQueue(
            item.toClientMessage(),
            to: peerIds,
            requireRecipient: false,
            failureReason: "profile reached no recipient devices",
            markUndelivered: { try? await self.content.setProfileUndelivered(userId: session.userId, updatedAt: sentAt, undelivered: true) }
        )
    }

    private func deliverOrQueue(
        _ message: Obscura_Client_V1_ClientMessage,
        to recipientUserIds: [String],
        requireRecipient: Bool,
        failureReason: String,
        markUndelivered: () async -> Void
    ) async throws {
        do {
            let report = try await send(message, to: recipientUserIds)
            if (requireRecipient || !recipientUserIds.isEmpty) && !report.recipients.contains(where: { $0.status == .accepted }) {
                throw ObscuraError.sendFailed(failureReason)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await markUndelivered()
            throw error
        }
    }

    public func flushOutbox() async throws -> Int {
        _ = try await sendContext()
        let acceptedFriends = Set(try await friends.all().filter { $0.status == .accepted }.map(\.userId))
        var delivered = 0

        for row in try await content.undeliveredMessages() {
            guard acceptedFriends.contains(row.peerUserId) else { continue }
            if let report = try? await send(row.toClientMessage(), to: [row.peerUserId]),
               report.recipients.contains(where: { $0.status == .accepted }) {
                try await content.setMessageUndelivered(id: row.id, undelivered: false)
                delivered += 1
            }
        }

        let friendList = Array(acceptedFriends)
        for row in try await content.undeliveredStories() {
            if let report = try? await send(row.toClientMessage(), to: friendList),
               friendList.isEmpty || report.recipients.contains(where: { $0.status == .accepted }) {
                try await content.setStoryUndelivered(id: row.id, undelivered: false)
                delivered += 1
            }
        }

        for row in try await content.undeliveredProfiles() {
            if let report = try? await send(row.toClientMessage(), to: friendList),
               friendList.isEmpty || report.recipients.contains(where: { $0.status == .accepted }) {
                try await content.setProfileUndelivered(userId: row.userId, updatedAt: row.updatedAt, undelivered: false)
                delivered += 1
            }
        }

        return delivered
    }

    public func sweepExpired(
        now: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)
    ) async throws -> (purgedMediaRefs: [String], touchedModels: [String]) {
        let outcome = try await content.sweepExpired(now: now)
        if let cacheDir = attachmentCacheDir {
            for id in outcome.purgedMediaRefs {
                AttachmentCrypto.purgeCached(cacheDir: cacheDir, id: id)
            }
        }
        return outcome
    }

    /// Sends a `ClientMessage` to every device of the named users and to this user's other devices.
    func send(_ message: Obscura_Client_V1_ClientMessage, to recipientUserIds: [String]) async throws -> SendReport {
        let data = try message.serializedData()

        let (userId, sender) = try await sendContext()
        let generation = sessionGeneration
        let peers = Self.distinct(recipientUserIds, excluding: userId)
        let results = await sender.send(to: peers + [userId], data)
        try Task.checkCancellation()
        guard generation == sessionGeneration else { throw CancellationError() }
        return SendReport(
            recipients: results.filter { $0.userId != userId },
            selfSync: results.filter { $0.userId == userId }
        )
    }

    /// Every send refreshes a near-expiry token once, up front.
    func sendContext() async throws -> (userId: String, sender: MessageSender) {
        let session = try await requireFreshSession()
        guard let sender else { throw ObscuraError.notAuthenticated }
        return (session.userId, sender)
    }

    func sendControl(_ message: Obscura_Client_V1_ClientMessage, to userId: String) async throws {
        try await sendContext().sender.sendOrThrow(to: userId, message.serializedData())
    }

    static func distinct(_ userIds: [String], excluding excluded: String) -> [String] {
        var seen: Set<String> = [excluded]
        return userIds.filter { seen.insert($0).inserted }
    }

    // MARK: - Friends

    /// Primary only.
    public func addFriendByCode(_ code: String) async throws {
        let decoded = try FriendCode.decode(code)
        try await befriend(decoded.userId, username: decoded.username)
    }

    public func friendCode() throws -> String {
        let session = try requireSession()
        return FriendCode.encode(userId: session.userId, username: session.username)
    }

    func befriend(_ userId: String, username: String) async throws {
        let me = try requireSession()
        guard userId != me.userId else {
            throw ObscuraError.invalidArgument("cannot befriend yourself")
        }
        try await requirePrimary()
        let existing = try await friends.friend(userId)?.status
        switch existing {
        case .accepted?: return
        case .pendingReceived?: return try await acceptFriend(userId)
        case .pendingSent?, nil: break
        }
        var message = Obscura_Client_V1_ClientMessage()
        message.friendRequest.username = me.username
        if existing == nil { try await friends.add(userId, username: username, status: .pendingSent) }
        do {
            try await sendControl(message, to: userId)
        } catch {
            if existing == nil { _ = try await friends.removePendingSent(userId) }
            throw error
        }
        if existing == nil { try await syncFriendList() }
    }

    /// Primary only.
    public func acceptFriend(_ userId: String) async throws {
        try await requirePrimary()
        guard try await friends.friend(userId) != nil else {
            throw ObscuraError.invalidArgument("no friend request from \(userId)")
        }
        try await sendFriendAccept(to: userId)
        try await friends.updateStatus(userId, .accepted)
        try await syncFriendList()
    }

    func sendFriendAccept(to userId: String) async throws {
        var message = Obscura_Client_V1_ClientMessage()
        message.friendAccept = Obscura_Client_V1_FriendAccept()
        try await sendControl(message, to: userId)
    }

    /// Primary only. Forgets the friend and their devices locally. Nothing is sent to them.
    public func removeFriend(_ userId: String) async throws {
        try await requirePrimary()
        try await friends.remove(userId)
        try await syncFriendList()
    }

    /// Sends the whole friend list to this account's other devices. Delivery failures are logged: the
    /// next change sends the whole list again.
    func syncFriendList() async throws {
        let (userId, sender) = try await sendContext()
        var message = Obscura_Client_V1_ClientMessage()
        message.friendListSync = try await friends.listSync()
        let results = await sender.send(to: userId, try message.serializedData())
        for result in results where result.status != .accepted {
            logger.log("friend list sync to \(result.deviceId ?? userId) \(result.status.rawValue): \(result.error ?? "")")
        }
    }

    public func getFriends() async throws -> [Friend] {
        try await friends.all()
    }

    // MARK: - Typing

    static func typingConvId(_ userA: String, _ userB: String) -> String {
        userA <= userB ? "\(userA)_\(userB)" : "\(userB)_\(userA)"
    }

    public func sendTyping(peerUserId: String, state: TypingState) async throws {
        guard !peerUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("peerUserId must not be blank")
        }
        let selfId = try requireSession().userId
        let convId = Self.typingConvId(selfId, peerUserId)
        try await sendTyping(to: [peerUserId], contextId: convId, state: state)
    }

    public func observeTyping(peerUserId: String) async throws -> AsyncStream<Bool> {
        guard !peerUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("peerUserId must not be blank")
        }
        let selfId = try requireSession().userId
        let convId = Self.typingConvId(selfId, peerUserId)
        let upstream = observeTyping(contextId: convId)
        return AsyncStream { continuation in
            let task = Task {
                for await userIds in upstream {
                    continuation.yield(userIds.contains(peerUserId))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// At most one send per 2 s per (context, state). Delivery failures are logged, never thrown.
    public func sendTyping(to recipientUserIds: [String], contextId: String, state: TypingState) async throws {
        guard !contextId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("blank contextId")
        }
        _ = try requireSession()
        let key = "\(state.rawValue):\(contextId)"
        let now = Date()
        if let last = typingSentAt[key], now.timeIntervalSince(last) < 2 { return }
        typingSentAt[key] = now

        var message = Obscura_Client_V1_ClientMessage()
        message.typingSignal.contextID = contextId
        message.typingSignal.state = WireCodec.encodeTypingState(state)
        let data = try message.serializedData()

        let (userId, sender) = try await sendContext()
        let peers = Self.distinct(recipientUserIds, excluding: userId)
        let results = await sender.send(to: peers, data)
        for recipient in peers where !results.contains(where: { $0.userId == recipient && $0.status == .accepted }) {
            let errors = results.filter { $0.userId == recipient }.map { $0.error ?? $0.status.rawValue }.joined(separator: "; ")
            logger.log("typing signal to \(recipient) failed: \(errors)")
        }
    }

    /// The distinct user ids typing in `contextId`, sorted. Yields on subscribe and on every change.
    public nonisolated func observeTyping(contextId: String) -> AsyncStream<[String]> {
        typing.observe(contextId: contextId)
    }

    // MARK: - Attachments and push

    public func uploadAttachment(filePath: String) async throws -> UploadedAttachment {
        let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        return try await uploadAttachment(data)
    }

    /// Encrypts and uploads; the server only sees ciphertext. The app sends the result in an entry.
    public func uploadAttachment(_ plaintext: Data) async throws -> UploadedAttachment {
        _ = try await requireFreshSession()
        let generation = sessionGeneration
        let encrypted = try AttachmentCrypto.encrypt(plaintext)
        let response = try await api.uploadAttachment(encrypted.ciphertext)
        guard generation == sessionGeneration, !Task.isCancelled else { throw CancellationError() }
        return UploadedAttachment(id: response.id, contentKey: encrypted.contentKey, nonce: encrypted.nonce)
    }

    public func downloadAttachmentToCache(id: String, contentKeyBase64: String, nonceBase64: String) async throws -> String {
        guard let cacheDir = attachmentCacheDir else {
            throw ObscuraError.storageFailed("attachment cache directory unavailable")
        }
        if let cached = AttachmentCrypto.readCached(cacheDir: cacheDir, id: id) {
            return cached.path
        }
        guard let keyData = Data(base64Encoded: contentKeyBase64), !keyData.isEmpty,
              let nonceData = Data(base64Encoded: nonceBase64), !nonceData.isEmpty else {
            throw ObscuraError.invalidArgument("invalid base64 key/nonce")
        }
        let data = try await downloadDecryptedAttachment(id: id, contentKey: keyData, nonce: nonceData)
        let dest = try AttachmentCrypto.writeCached(cacheDir: cacheDir, id: id, data: data)
        return dest.path
    }

    public func downloadDecryptedAttachment(id: String, contentKey: Data, nonce: Data) async throws -> Data {
        _ = try await requireFreshSession()
        let generation = sessionGeneration
        let ciphertext = try await api.fetchAttachment(id)
        guard generation == sessionGeneration, !Task.isCancelled else { throw CancellationError() }
        return try AttachmentCrypto.open(ciphertext, key: contentKey, nonce: nonce)
    }

    public func registerPushToken(_ token: String) async throws {
        _ = try await requireFreshSession()
        let generation = sessionGeneration
        try await api.registerPushToken(token)
        guard generation == sessionGeneration, !Task.isCancelled else { throw CancellationError() }
    }
}
