import Foundation
import GRDB
import LibSignalClient

enum PersistedContent: Sendable, Equatable {
    case handled
    case inboxed(modelKey: String?)
    /// The primary's friend list changed: its other devices get the new list.
    case friendsChanged
    /// Needs a network reply or in-memory state, outside the transaction.
    case control(Obscura_Client_V1_ClientMessage)
    /// Acknowledged without effect, for the logged reason.
    case ignored(String)
    case malformed(String)
}

extension ObscuraClient {
    /// Returns once the gateway socket is open. Joins a connect in flight; cuts short a pending
    /// reconnect backoff. Safe to call on every app foreground.
    public func connect() async throws {
        try Task.checkCancellation()
        guard session != nil else { throw ObscuraError.notAuthenticated }
        startPreKeySync()
        do {
            if try PreKeys.isSyncDue(signalStore, nowMs: clock()) { requestPreKeySync() }
        } catch {
            logger.databaseError(store: "signal", operation: "preKeyState", reason: "\(error)")
        }
        if connection.value == .connected { return }
        if let connectTask { return try await connectTask.value }
        reconnectTask?.cancel()
        reconnectTask = nil
        let generation = connectionGeneration
        let task = Task { try await self.openSocket(generation) }
        connectTask = task
        defer { if connectTask == task { connectTask = nil } }
        try await task.value
    }

    /// Closes the socket and stops reconnecting.
    public func disconnect() {
        connectionGeneration += 1
        recovering = false
        reconnectAttempts = 0
        connectTask?.cancel()
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.close()
        socket = nil
        connection.set(.disconnected)
    }

    private func openSocket(_ generation: Int) async throws {
        guard generation == connectionGeneration, !Task.isCancelled else { throw CancellationError() }
        connection.set(recovering ? .reconnecting : .connecting)
        do {
            guard try await freshToken() != .rejected else { throw ObscuraError.notAuthenticated }
            guard generation == connectionGeneration else { throw CancellationError() }
            let socket = try await GatewaySocket.open(gatewayURL(ticket: api.fetchGatewayTicket()), logger: logger)
            guard generation == connectionGeneration, session != nil else {
                socket.close()
                throw CancellationError()
            }
            install(socket)
        } catch {
            logger.log("gateway connect failed: \(error)")
            if generation == connectionGeneration {
                if recovering && session != nil { scheduleReconnect() } else { connection.set(.disconnected) }
            }
            if let error = error as? URLError {
                if error.code == .cancelled { throw CancellationError() }
                throw ObscuraError.connectionFailed(error.localizedDescription)
            }
            throw error
        }
    }

    private func gatewayURL(ticket: String) throws -> URL {
        guard var components = URLComponents(url: api.baseURL.appendingPathComponent("v1/gateway"), resolvingAgainstBaseURL: false) else {
            throw ObscuraError.invalidArgument("apiURL \(api.baseURL)")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let url = components.url else { throw ObscuraError.protocolViolation("gateway ticket is not URL-safe") }
        return url
    }

    private func install(_ socket: GatewaySocket) {
        self.socket = socket
        recovering = false
        reconnectAttempts = 0
        connection.set(.connected)
        receiveTask = Task { [weak self] in
            do {
                for try await event in socket.events {
                    await self?.handle(event, from: socket)
                }
            } catch {
                self?.logger.log("gateway closed: \(error)")
            }
            await self?.socketEnded(socket)
        }
    }

    private func socketEnded(_ ended: GatewaySocket) {
        guard socket === ended else { return }
        socket = nil
        recovering = true
        scheduleReconnect()
    }

    /// 1 s doubling to 30 s.
    private func scheduleReconnect() {
        let delay = min(UInt64(1) << UInt64(min(reconnectAttempts, 5)), 30)
        reconnectAttempts += 1
        connection.set(.reconnecting)
        logger.log("gateway reconnect in \(delay)s (attempt \(reconnectAttempts))")
        let generation = connectionGeneration
        reconnectTask = Task { [weak self] in
            guard (try? await Task.sleep(nanoseconds: delay * 1_000_000_000)) != nil else { return }
            await self?.reconnect(generation)
        }
    }

    private func reconnect(_ generation: Int) async {
        guard generation == connectionGeneration else { return }
        reconnectTask = nil
        // A failure has already been logged and the next attempt scheduled.
        _ = try? await connect()
    }

    // MARK: - Receive

    private func handle(_ event: GatewayEvent, from socket: GatewaySocket) async {
        guard self.socket === socket, session != nil, !Task.isCancelled else { return }
        switch event {
        case .envelope(let envelope):
            await receive(envelope) { try await socket.acknowledge($0) }
        }
    }

    /// Persist, then ack. Anything that fails before the ack leaves the envelope on the server.
    func receive(_ envelope: Envelope, acknowledge: @Sendable (Data) async throws -> Void) async {
        let generation = sessionGeneration
        guard let envelopeId = uuidString(envelope.id), let senderUserId = uuidString(envelope.senderUserId),
              let senderDeviceId = uuidString(envelope.senderDeviceId) else {
            logger.decryptFailed(sourceUserId: uuidString(envelope.senderUserId) ?? "unknown", reason:
                "malformed envelope (id \(envelope.id.count) bytes, sender \(envelope.senderUserId.count), "
                + "sender device \(envelope.senderDeviceId.count)); not acked")
            return
        }
        do {
            if try await content.containsEnvelope(envelopeId) {
                await ack(envelope.id, envelopeId, acknowledge)
                return
            }
        } catch {
            logger.databaseError(store: "content", operation: "containsEnvelope", reason: "\(error)")
            return
        }
        let content: PersistedContent
        let selfUserId = session?.userId
        var preKeyMessage = false
        do {
            let encrypted = try Obscura_Client_V1_EncryptedMessage(serializedBytes: envelope.message)
            preKeyMessage = encrypted.type == .prekeyMessage
            content = try await messenger.decryptAndPersist(senderUserId: senderUserId, senderDeviceUuid: senderDeviceId,
                                                            encrypted) { plaintext, db in
                try Task.checkCancellation()
                let message: Obscura_Client_V1_ClientMessage
                do {
                    message = try Obscura_Client_V1_ClientMessage(serializedBytes: plaintext)
                } catch {
                    return .malformed("\(error)")
                }
                return try Self.persist(message, envelopeId: envelopeId, senderUserId: senderUserId,
                                        senderDeviceId: senderDeviceId, selfUserId: selfUserId, in: db)
            }
        } catch is CancellationError {
            return
        } catch SignalError.duplicatedMessage {
            // Decrypt commits only with its durable writes, so a spent message key means this
            // redelivered envelope is already stored.
            logger.log("redelivered envelope \(envelopeId) was already processed; acked")
            await ack(envelope.id, envelopeId, acknowledge)
            return
        } catch let error as DatabaseError {
            logger.databaseError(store: "receive", operation: "persist", reason: "\(error)")
            return
        } catch {
            logger.decryptFailed(sourceUserId: senderUserId, reason: "\(error)")
            return
        }
        guard generation == sessionGeneration, !Task.isCancelled else { return }
        switch content {
        case .handled:
            break
        case .inboxed(let modelKey):
            if let modelKey { messageContinuation.yield(modelKey) }
        case .friendsChanged:
            do {
                try await syncFriendList()
            } catch {
                logger.log("friend list sync failed: \(error)")
            }
        case .control(let message):
            do {
                try await control(message, senderUserId: senderUserId, senderDeviceId: senderDeviceId)
            } catch {
                logger.databaseError(store: "receive", operation: WireCodec.messageKind(message.payload), reason: "\(error)")
                return
            }
        case .ignored(let reason):
            logger.log("ignored a message from \(senderUserId) device \(senderDeviceId): \(reason)")
        case .malformed(let reason):
            // Its ratchet step is committed and it can never parse, so it is acked and dropped.
            logger.log("dropped an unparseable client message from \(senderUserId): \(reason)")
        }
        guard generation == sessionGeneration, !Task.isCancelled else { return }
        // As Signal-Android does after a pre-key message: the sender used up one of this device's keys.
        if preKeyMessage { requestPreKeySync() }
        await ack(envelope.id, envelopeId, acknowledge)
    }

    static func peerUserId(senderUserId: String, claimedPeerUserId: String, selfUserId: String?) -> String? {
        let claimed = claimedPeerUserId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let selfUserId else { return senderUserId }
        if senderUserId == selfUserId {
            guard !claimed.isEmpty, claimed != selfUserId else { return nil }
            return claimedPeerUserId
        } else {
            if !claimed.isEmpty, claimed != selfUserId, claimed != senderUserId {
                return nil
            }
            return senderUserId
        }
    }

    /// The durable part of handling a decrypted message, in the decrypt's transaction. Friend requests
    /// and accepts change only the primary's list; a linked device takes the list only from its
    /// account's primary, and only a newer version.
    static func persist(_ message: Obscura_Client_V1_ClientMessage, envelopeId: String, senderUserId: String,
                        senderDeviceId: String, selfUserId: String?, in db: Database) throws -> PersistedContent {
        if try ContentStore.containsEnvelope(envelopeId, in: db) {
            return .handled
        }
        let sentAt = clampFuture(message.timestamp)
        switch message.payload {
        case .directMessage(let dm)?:
            guard !dm.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let peer = peerUserId(senderUserId: senderUserId, claimedPeerUserId: dm.peerUserID, selfUserId: selfUserId) else {
                return .ignored("direct message with blank id or invalid peer")
            }
            let item = ConversationItem.message(
                id: dm.id,
                peerUserId: peer,
                authorUserId: senderUserId,
                sentAt: sentAt,
                content: dm.content
            )
            let inserted = try ContentStore.insertConversationItem(item, undelivered: false, in: db)
            try ContentStore.recordEnvelope(envelopeId, in: db)
            return .inboxed(modelKey: inserted ? "directMessage" : nil)
        case .pix(let pix)?:
            guard !pix.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let peer = peerUserId(senderUserId: senderUserId, claimedPeerUserId: pix.peerUserID, selfUserId: selfUserId),
                  pix.hasAttachment,
                  let attachment = MediaAttachment(proto: pix.attachment) else {
                return .ignored("pix message with invalid id, peer, or attachment")
            }
            let item = ConversationItem.pix(
                id: pix.id,
                peerUserId: peer,
                authorUserId: senderUserId,
                sentAt: sentAt,
                attachment: attachment,
                caption: pix.caption,
                captionMeta: pix.captionMeta,
                displayDuration: Int(pix.displayDurationSecs)
            )
            let inserted = try ContentStore.insertConversationItem(item, undelivered: false, in: db)
            try ContentStore.recordEnvelope(envelopeId, in: db)
            return .inboxed(modelKey: inserted ? "pix" : nil)
        case .seenReceipt(let sr)?:
            guard !sr.entryID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let peer = peerUserId(senderUserId: senderUserId, claimedPeerUserId: sr.peerUserID, selfUserId: selfUserId) else {
                return .ignored("seen receipt with blank entryId or invalid peer")
            }
            let updated = try ContentStore.applySeenReceipt(
                entryId: sr.entryID,
                peerUserId: peer,
                senderUserId: senderUserId,
                viewedAt: min(sr.viewedAt, sentAt),
                in: db
            )
            try ContentStore.recordEnvelope(envelopeId, in: db)
            return .inboxed(modelKey: updated ? "seen" : nil)
        case .story(let st)?:
            guard !st.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .ignored("story with blank id")
            }
            let item = StoryItem(
                id: st.id,
                authorUserId: senderUserId,
                sentAt: sentAt,
                content: st.content,
                attachment: st.hasAttachment ? MediaAttachment(proto: st.attachment) : nil,
                captionMeta: st.captionMeta
            )
            let inserted = try ContentStore.insertStoryItem(item, undelivered: false, in: db)
            try ContentStore.recordEnvelope(envelopeId, in: db)
            return .inboxed(modelKey: inserted ? "story" : nil)
        case .profile(let pr)?:
            let item = ProfileItem(
                userId: senderUserId,
                authorDeviceId: senderDeviceId,
                updatedAt: sentAt,
                displayName: pr.displayName,
                bio: pr.bio
            )
            let updated = try ContentStore.upsertProfile(item, undelivered: false, in: db)
            try ContentStore.recordEnvelope(envelopeId, in: db)
            return .inboxed(modelKey: updated ? "profile" : nil)
        case nil:
            return .ignored("unknown client message arm")
        case .friendRequest(let request)?:
            guard try DeviceStore.isPrimary(in: db) else { return .ignored("friend request on a linked device") }
            switch try FriendStore.friend(senderUserId, in: db)?.status {
            case nil:
                try FriendStore.add(senderUserId, username: request.username, status: .pendingReceived, in: db)
                return .friendsChanged
            case .pendingReceived?:
                return .handled
            case .accepted?, .pendingSent?:
                return .control(message)
            }
        case .friendAccept?:
            guard try DeviceStore.isPrimary(in: db) else { return .ignored("friend accept on a linked device") }
            guard try FriendStore.friend(senderUserId, in: db)?.status == .pendingSent else { return .control(message) }
            try FriendStore.updateStatus(senderUserId, .accepted, in: db)
            return .friendsChanged
        case .friendListSync(let sync)?:
            guard senderUserId == selfUserId, try senderDeviceId == DeviceStore.primaryDeviceId(in: db),
                  try !DeviceStore.isPrimary(in: db) else { return .ignored("friend list sync not from this account's primary") }
            let held = try FriendStore.version(in: db)
            guard sync.version > held else { return .ignored("friend list version \(sync.version), holding \(held)") }
            let friends: [Friend]
            do {
                friends = try WireCodec.friends(sync.friends)
            } catch {
                return .ignored("\(error)")
            }
            try FriendStore.replace(friends, version: sync.version, in: db)
            return .handled
        case .typingSignal?:
            return .control(message)
        }
    }

    private func ack(_ id: Data, _ envelopeId: String, _ acknowledge: @Sendable (Data) async throws -> Void) async {
        do { try await acknowledge(id) } catch { logger.ackFailed(envelopeId: envelopeId, reason: "\(error)") }
    }

    private func control(_ message: Obscura_Client_V1_ClientMessage, senderUserId: String, senderDeviceId: String) async throws {
        switch message.payload {
        case .friendRequest(let request)?:
            try await receivedFriendRequest(from: senderUserId, username: request.username)
        case .friendAccept?:
            logger.log("ignoring unsolicited FRIEND_ACCEPT from \(senderUserId)")
        case .typingSignal(let signal)?:
            receivedTyping(signal, senderUserId: senderUserId, senderDeviceId: senderDeviceId)
        case .directMessage?, .pix?, .seenReceipt?, .story?, .profile?, .friendListSync?, nil:
            throw ObscuraError.protocolViolation("\(WireCodec.messageKind(message.payload)) is not a control message")
        }
    }

    /// A far-future timestamp would win every later merge.
    static func clampFuture(_ sentAt: UInt64, now: UInt64 = nowMs()) -> UInt64 {
        min(sentAt, now + 60_000)
    }

    /// Known requests never relabel peers. An accepted account gets an idempotent accept reply.
    private func receivedFriendRequest(from userId: String, username: String) async throws {
        switch try await friends.friend(userId)?.status {
        case .pendingSent?: try await acceptFriend(userId)
        case .accepted?: try await sendFriendAccept(to: userId)
        case nil, .pendingReceived?: break
        }
    }

    private func receivedTyping(_ signal: Obscura_Client_V1_TypingSignal, senderUserId: String, senderDeviceId: String) {
        guard !signal.contextID.isEmpty, let state = WireCodec.decodeTypingState(signal.state) else { return }
        switch state {
        case .started: typing.started(contextId: signal.contextID, userId: senderUserId, deviceId: senderDeviceId)
        case .stopped: typing.stopped(contextId: signal.contextID, deviceId: senderDeviceId)
        }
    }

    // MARK: - Prekeys

    /// For tests: sync timing takes effect at the next session's first sync request.
    func setPreKeySyncTiming(checkIntervalMs: UInt64, spacingMs: UInt64) {
        preKeyCheckIntervalMs = checkIntervalMs
        preKeySyncSpacingMs = spacingMs
    }

    func setClock(_ clock: @escaping @Sendable () -> Int64) {
        self.clock = clock
    }

    func requestPreKeySync() {
        startPreKeySync()
        preKeySyncRequests?.yield()
    }

    /// Starts the session's sync task if it is not running: it syncs on each request, at least
    /// `preKeySyncSpacingMs` apart, and requests one every `preKeyCheckIntervalMs`.
    func startPreKeySync() {
        guard session != nil, preKeySyncTask == nil else { return }
        let generation = sessionGeneration
        let (requests, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        preKeySyncRequests = continuation
        let interval = preKeyCheckIntervalMs
        let spacing = preKeySyncSpacingMs
        preKeySyncTask = Task { [weak self] in
            let ticker = Task {
                while (try? await Task.sleep(nanoseconds: interval * 1_000_000)) != nil {
                    continuation.yield()
                }
            }
            defer { ticker.cancel() }
            // Ends when the session's end cancels this task or finishes the stream.
            for await _ in requests {
                guard let self else { return }
                await self.syncPreKeys(generation)
                guard (try? await Task.sleep(nanoseconds: spacing * 1_000_000)) != nil else { return }
            }
        }
    }

    /// Signal-Android's `PreKeysSyncJob`: ask the server how many one-time keys it still holds for this
    /// device, upload a refill of each kind it is short of and the signed and last-resort keys due for
    /// rotation, then clean up old keys.
    func syncPreKeys(_ generation: Int) async {
        guard generation == sessionGeneration, session != nil, !Task.isCancelled else { return }
        do {
            _ = try await requireFreshSession()
            guard generation == sessionGeneration, !Task.isCancelled else { return }
            let counts = try await api.fetchPreKeyCounts()
            let store = signalStore
            let now = clock()
            // Off the actor: a Kyber batch takes a while to generate.
            let refill = try await Task.detached { try PreKeys.prepareRefill(store, counts: counts, nowMs: now) }.value
            if !refill.isEmpty { try await api.uploadPreKeys(refill.upload()) }
            guard generation == sessionGeneration else { return }
            try PreKeys.confirmRefill(signalStore, refill, nowMs: clock())
            if !refill.isEmpty { logger.log("prekeys uploaded (counts were \(counts.oneTime) EC, \(counts.kyber) Kyber)") }
        } catch is CancellationError {
            return
        } catch {
            logger.preKeySyncFailed(reason: "\(error)")
        }
    }
}
