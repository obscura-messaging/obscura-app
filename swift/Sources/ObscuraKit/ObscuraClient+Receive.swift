import Foundation
import GRDB
import LibSignalClient

enum PersistedContent: Sendable, Equatable {
    case handled
    case inboxed(modelKey: EntryModel?)
    /// The primary's friend list changed: its other devices get the new list.
    case friendsChanged
    /// Needs a network reply or in-memory state, outside the transaction.
    case control(Obscura_Client_V1_ClientMessage)
    /// Acknowledged without effect, for the logged reason.
    case ignored(String)
    case malformed(String)
}

extension ObscuraClient {
    // MARK: - Receive

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
            return .inboxed(modelKey: inserted ? .directMessage : nil)
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
            return .inboxed(modelKey: inserted ? .pix : nil)
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
            return .inboxed(modelKey: updated ? .seen : nil)
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
            return .inboxed(modelKey: inserted ? .story : nil)
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
            return .inboxed(modelKey: updated ? .profile : nil)
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
}
