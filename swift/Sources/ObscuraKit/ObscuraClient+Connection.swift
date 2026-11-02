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
        case .preKeyStatus(let count, let threshold):
            if count < threshold { replenishPreKeys() }
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
            if try await inbox.contains(envelopeId: envelopeId) {
                await ack(envelope.id, envelopeId, acknowledge)
                return
            }
        } catch {
            logger.databaseError(store: "inbox", operation: "contains", reason: "\(error)")
            return
        }
        let content: PersistedContent
        let selfUserId = session?.userId
        do {
            let encrypted = try Obscura_Client_V1_EncryptedMessage(serializedBytes: envelope.message)
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
        replenishPreKeysIfLow()
        await ack(envelope.id, envelopeId, acknowledge)
    }

    /// The durable part of handling a decrypted message, in the decrypt's transaction. Friend requests
    /// and accepts change only the primary's list; a linked device takes the list only from its
    /// account's primary, and only a newer version.
    static func persist(_ message: Obscura_Client_V1_ClientMessage, envelopeId: String, senderUserId: String,
                        senderDeviceId: String, selfUserId: String?, in db: Database) throws -> PersistedContent {
        switch message.payload {
        case .appEntry(let entry)?:
            guard !entry.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !entry.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return .ignored("app entry with blank model or id")
            }
            let inserted = try InboxStore.put(InboxInsert(
                envelopeId: envelopeId, senderUserId: senderUserId,
                senderDeviceId: senderDeviceId, modelKey: entry.model, entryId: entry.id,
                sentAt: clampFuture(entry.timestamp), payload: entry.data), in: db)
            return .inboxed(modelKey: inserted ? entry.model : nil)
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
            let friends: [(userId: String, username: String, status: FriendStatus)]
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
        case .appEntry?, .friendListSync?, nil:
            throw ObscuraError.protocolViolation("\(WireCodec.messageKind(message.payload)) is not a control message")
        }
    }

    /// A far-future timestamp would win every later merge.
    static func clampFuture(_ sentAt: UInt64) -> UInt64 {
        min(sentAt, UInt64(Date().timeIntervalSince1970 * 1000) + 60_000)
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

    private func replenishPreKeysIfLow() {
        do {
            if try signalStore.preKeyCount() < Self.preKeyMinimum { replenishPreKeys() }
        } catch {
            logger.databaseError(store: "signal", operation: "preKeyCount", reason: "\(error)")
        }
    }

    private func replenishPreKeys() {
        guard replenishTask == nil else { return }
        let generation = sessionGeneration
        replenishTask = Task { await self.performReplenish(generation) }
    }

    private func performReplenish(_ generation: Int) async {
        defer { if generation == sessionGeneration { replenishTask = nil } }
        guard generation == sessionGeneration, session != nil, !Task.isCancelled else { return }
        do {
            _ = try await requireFreshSession()
            guard generation == sessionGeneration, !Task.isCancelled else { return }
            let keys = try signalStore.addPreKeys(Self.preKeyReplenishCount)
            try await api.uploadPreKeys(keys)
            try signalStore.retireSignedPreKeys(publishedId: keys.signedPreKey.keyId)
        } catch {
            logger.preKeyReplenishFailed(reason: "\(error)")
        }
    }
}
