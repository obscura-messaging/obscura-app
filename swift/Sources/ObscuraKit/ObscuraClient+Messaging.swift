import Foundation

extension ObscuraClient {
    // MARK: - Send

    /// Sends an entry to every device of the named users and to this user's other devices. This
    /// device gets nothing, so the app stores its own copy in `entries`.
    public func send(to recipientUserIds: [String], modelKey: String, entryId: String, sentAt: UInt64,
                     payload: Data) async throws -> SendReport {
        var message = Obscura_Client_V1_ClientMessage()
        message.appEntry.model = modelKey
        message.appEntry.id = entryId
        message.appEntry.timestamp = sentAt
        message.appEntry.data = payload
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

    /// Encrypts and uploads; the server only sees ciphertext. The app sends the result in an entry.
    public func uploadAttachment(_ plaintext: Data) async throws -> UploadedAttachment {
        _ = try await requireFreshSession()
        let generation = sessionGeneration
        let encrypted = try AttachmentCrypto.encrypt(plaintext)
        let response = try await api.uploadAttachment(encrypted.ciphertext)
        guard generation == sessionGeneration, !Task.isCancelled else { throw CancellationError() }
        return UploadedAttachment(id: response.id, contentKey: encrypted.contentKey, nonce: encrypted.nonce)
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
