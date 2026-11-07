import Foundation
import GRDB

public struct MediaAttachment: Sendable, Equatable {
    public let id: String
    public let contentKey: Data
    public let nonce: Data
    public let mediaType: String

    public init(id: String, contentKey: Data, nonce: Data, mediaType: String = "photo") {
        self.id = id
        self.contentKey = contentKey
        self.nonce = nonce
        self.mediaType = mediaType.isEmpty ? "photo" : mediaType
    }

    init?(proto: Obscura_Client_V1_AttachmentPointer) {
        guard !proto.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !proto.contentKey.isEmpty,
              !proto.nonce.isEmpty else {
            return nil
        }
        self.init(
            id: proto.id,
            contentKey: proto.contentKey,
            nonce: proto.nonce,
            mediaType: proto.mediaType
        )
    }

    var proto: Obscura_Client_V1_AttachmentPointer {
        var pointer = Obscura_Client_V1_AttachmentPointer()
        pointer.id = id
        pointer.contentKey = contentKey
        pointer.nonce = nonce
        pointer.mediaType = mediaType
        return pointer
    }
}

public struct ConversationItem: Sendable, Equatable {
    public let id: String
    public let peerUserId: String
    public let kind: String
    public let authorUserId: String
    public let sentAt: UInt64
    public let viewedAt: UInt64?
    public let content: String
    public let attachment: MediaAttachment?
    public let caption: String?
    public let captionMeta: String?
    public let displayDuration: Int

    public init(
        id: String,
        peerUserId: String,
        kind: String,
        authorUserId: String,
        sentAt: UInt64,
        viewedAt: UInt64?,
        content: String,
        attachment: MediaAttachment? = nil,
        caption: String? = nil,
        captionMeta: String? = nil,
        displayDuration: Int = 0
    ) {
        precondition(kind == "message" || kind == "pix", "invalid conversation item kind: \(kind)")
        if kind == "pix" {
            precondition(attachment != nil, "pix requires an attachment")
        } else {
            precondition(
                attachment == nil && caption == nil && captionMeta == nil && displayDuration == 0,
                "message cannot carry pix fields"
            )
        }
        self.id = id
        self.peerUserId = peerUserId
        self.kind = kind
        self.authorUserId = authorUserId
        self.sentAt = sentAt
        self.viewedAt = viewedAt
        self.content = content
        self.attachment = attachment
        self.caption = (caption?.isEmpty == false) ? caption : nil
        self.captionMeta = (captionMeta?.isEmpty == false) ? captionMeta : nil
        self.displayDuration = max(0, displayDuration)
    }

    public static func message(
        id: String,
        peerUserId: String,
        authorUserId: String,
        sentAt: UInt64,
        content: String,
        viewedAt: UInt64? = nil
    ) -> ConversationItem {
        ConversationItem(
            id: id,
            peerUserId: peerUserId,
            kind: "message",
            authorUserId: authorUserId,
            sentAt: sentAt,
            viewedAt: viewedAt,
            content: content
        )
    }

    public static func pix(
        id: String,
        peerUserId: String,
        authorUserId: String,
        sentAt: UInt64,
        attachment: MediaAttachment,
        caption: String? = nil,
        captionMeta: String? = nil,
        displayDuration: Int = 0,
        viewedAt: UInt64? = nil
    ) -> ConversationItem {
        ConversationItem(
            id: id,
            peerUserId: peerUserId,
            kind: "pix",
            authorUserId: authorUserId,
            sentAt: sentAt,
            viewedAt: viewedAt,
            content: "",
            attachment: attachment,
            caption: caption,
            captionMeta: captionMeta,
            displayDuration: displayDuration
        )
    }

    func toClientMessage() -> Obscura_Client_V1_ClientMessage {
        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = sentAt
        if let attachment {
            message.pix.id = id
            message.pix.peerUserID = peerUserId
            message.pix.attachment = attachment.proto
            message.pix.caption = caption ?? ""
            message.pix.captionMeta = captionMeta ?? ""
            message.pix.displayDurationSecs = UInt32(displayDuration)
        } else {
            message.directMessage.id = id
            message.directMessage.peerUserID = peerUserId
            message.directMessage.content = content
        }
        return message
    }

    var snapshotRecord: Obscura_Client_V1_StoredMessageRecord {
        var record = Obscura_Client_V1_StoredMessageRecord()
        record.id = id
        record.peerUserID = peerUserId
        record.kind = kind
        record.authorUserID = authorUserId
        record.sentAt = sentAt
        record.viewedAt = viewedAt ?? 0
        record.content = content
        if let attachment {
            record.attachment = attachment.proto
        }
        record.caption = caption ?? ""
        record.captionMeta = captionMeta ?? ""
        record.displayDurationSecs = UInt32(displayDuration)
        return record
    }
}

public struct StoryItem: Sendable, Equatable {
    public let id: String
    public let authorUserId: String
    public let sentAt: UInt64
    public let content: String
    public let attachment: MediaAttachment?
    public let captionMeta: String?

    public init(
        id: String,
        authorUserId: String,
        sentAt: UInt64,
        content: String,
        attachment: MediaAttachment? = nil,
        captionMeta: String? = nil
    ) {
        self.id = id
        self.authorUserId = authorUserId
        self.sentAt = sentAt
        self.content = content
        self.attachment = attachment
        self.captionMeta = (captionMeta?.isEmpty == false) ? captionMeta : nil
    }

    func toClientMessage() -> Obscura_Client_V1_ClientMessage {
        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = sentAt
        message.story.id = id
        message.story.content = content
        if let attachment {
            message.story.attachment = attachment.proto
        }
        message.story.captionMeta = captionMeta ?? ""
        return message
    }

    var snapshotRecord: Obscura_Client_V1_StoredStoryRecord {
        var record = Obscura_Client_V1_StoredStoryRecord()
        record.id = id
        record.authorUserID = authorUserId
        record.sentAt = sentAt
        record.content = content
        if let attachment {
            record.attachment = attachment.proto
        }
        record.captionMeta = captionMeta ?? ""
        return record
    }
}

public struct ProfileItem: Sendable, Equatable {
    public let userId: String
    public let authorDeviceId: String
    public let updatedAt: UInt64
    public let displayName: String
    public let bio: String

    public init(
        userId: String,
        authorDeviceId: String,
        updatedAt: UInt64,
        displayName: String,
        bio: String
    ) {
        self.userId = userId
        self.authorDeviceId = authorDeviceId
        self.updatedAt = updatedAt
        self.displayName = displayName
        self.bio = bio
    }

    func toClientMessage() -> Obscura_Client_V1_ClientMessage {
        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = updatedAt
        message.profile.displayName = displayName
        message.profile.bio = bio
        return message
    }

    var snapshotRecord: Obscura_Client_V1_StoredProfileRecord {
        var record = Obscura_Client_V1_StoredProfileRecord()
        record.userID = userId
        record.authorDeviceID = authorDeviceId
        record.updatedAt = updatedAt
        record.displayName = displayName
        record.bio = bio
        return record
    }
}

/// Typed storage for conversation messages/pix, stories, profiles, envelope deduplication, and
/// erasure tombstones.
actor ContentStore {
    static let expireAfterViewMs: UInt64 = 15 * 60 * 1_000
    static let maxEphemeralAgeMs: UInt64 = 30 * 24 * 60 * 60 * 1_000
    static let storyMaxAgeMs: UInt64 = 24 * 60 * 60 * 1_000

    static func expiresAt(sentAt: UInt64, viewedAt: UInt64?) -> UInt64 {
        let ceiling = sentAt &+ maxEphemeralAgeMs < sentAt ? UInt64.max : sentAt + maxEphemeralAgeMs
        guard let viewedAt else { return ceiling }
        let seenExpiry = viewedAt &+ expireAfterViewMs < viewedAt ? UInt64.max : viewedAt + expireAfterViewMs
        return min(ceiling, seenExpiry)
    }

    static func storyExpiresAt(sentAt: UInt64) -> UInt64 {
        sentAt &+ storyMaxAgeMs < sentAt ? UInt64.max : sentAt + storyMaxAgeMs
    }

    private let db: DatabaseQueue

    init(db: DatabaseQueue) {
        self.db = db
    }

    // MARK: - Envelope deduplication

    func containsEnvelope(_ envelopeId: String) async throws -> Bool {
        try await db.read { db in
            try Self.containsEnvelope(envelopeId, in: db)
        }
    }

    static func containsEnvelope(_ envelopeId: String, in db: Database) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM processed_envelopes WHERE envelope_id = ?)",
                          arguments: [envelopeId]) == true
    }

    static func recordEnvelope(_ envelopeId: String, in db: Database) throws {
        try db.execute(sql: "INSERT OR IGNORE INTO processed_envelopes (envelope_id) VALUES (?)",
                       arguments: [envelopeId])
    }

    // MARK: - Conversation entries (messages & pix)

    func messages() async throws -> [ConversationItem] {
        try await db.read { db in try Self.messages(in: db) }
    }

    static func messages(in db: Database) throws -> [ConversationItem] {
        try Row.fetchAll(db, sql: "SELECT * FROM conversation_entries ORDER BY sent_at ASC, id ASC")
            .map(Self.conversationItem)
    }

    func message(id: String) async throws -> ConversationItem? {
        try await db.read { db in try Self.message(id: id, in: db) }
    }

    static func message(id: String, in db: Database) throws -> ConversationItem? {
        try Row.fetchOne(db, sql: "SELECT * FROM conversation_entries WHERE id = ?",
                         arguments: [id.storedText]).map(Self.conversationItem)
    }

    func undeliveredMessages() async throws -> [ConversationItem] {
        try await db.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM conversation_entries WHERE undelivered != 0 ORDER BY sent_at ASC, id ASC")
                .map(Self.conversationItem)
        }
    }

    @discardableResult
    func insertConversationItem(_ item: ConversationItem, undelivered: Bool = false) async throws -> Bool {
        try await db.write { db in
            try Self.insertConversationItem(item, undelivered: undelivered, in: db)
        }
    }

    @discardableResult
    static func insertConversationItem(_ item: ConversationItem, undelivered: Bool = false, in db: Database) throws -> Bool {
        if try isErased(item.id, in: db) || existsConversation(item.id, in: db) {
            return false
        }
        let expiry = expiresAt(sentAt: item.sentAt, viewedAt: item.viewedAt)
        try db.execute(sql: """
            INSERT INTO conversation_entries (
                id, peer_user_id, kind, author_user_id, sent_at, viewed_at, expires_at,
                content, media_ref, content_key, nonce, media_type, caption, caption_meta,
                display_duration, undelivered
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, arguments: [
            item.id.storedText,
            item.peerUserId.storedText,
            item.kind,
            item.authorUserId.storedText,
            Int64(clamping: item.sentAt),
            item.viewedAt.map { Int64(clamping: $0) },
            Int64(clamping: expiry),
            item.content.storedText,
            item.attachment?.id.storedText,
            item.attachment?.contentKey,
            item.attachment?.nonce,
            item.attachment?.mediaType.storedText,
            item.caption?.storedText,
            item.captionMeta?.storedText,
            item.displayDuration,
            undelivered ? 1 : 0,
        ])
        return true
    }

    func setMessageUndelivered(id: String, undelivered: Bool) async throws {
        try await db.write { db in
            try db.execute(sql: "UPDATE conversation_entries SET undelivered = ? WHERE id = ?",
                           arguments: [undelivered ? 1 : 0, id.storedText])
        }
    }

    func markSeenLocal(entryId: String, selfUserId: String, viewedAt: UInt64) async throws -> ConversationItem? {
        try await db.write { db in
            guard let row = try Self.message(id: entryId, in: db),
                  row.authorUserId != selfUserId,
                  row.viewedAt == nil else {
                return nil
            }
            let expiry = Self.expiresAt(sentAt: row.sentAt, viewedAt: viewedAt)
            try db.execute(sql: "UPDATE conversation_entries SET viewed_at = ?, expires_at = ? WHERE id = ?",
                           arguments: [Int64(clamping: viewedAt), Int64(clamping: expiry), entryId.storedText])
            return try Self.message(id: entryId, in: db)
        }
    }

    static func applySeenReceipt(
        entryId: String,
        peerUserId: String,
        senderUserId: String,
        viewedAt: UInt64,
        in db: Database
    ) throws -> Bool {
        guard let row = try message(id: entryId, in: db),
              row.peerUserId == peerUserId,
              row.authorUserId != senderUserId,
              row.viewedAt == nil else {
            return false
        }
        let expiry = expiresAt(sentAt: row.sentAt, viewedAt: viewedAt)
        try db.execute(sql: "UPDATE conversation_entries SET viewed_at = ?, expires_at = ? WHERE id = ?",
                       arguments: [Int64(clamping: viewedAt), Int64(clamping: expiry), entryId.storedText])
        return true
    }

    // MARK: - Story entries

    func stories(now: UInt64) async throws -> [StoryItem] {
        try await db.read { db in
            try Row.fetchAll(
                db,
                sql: "SELECT * FROM story_entries WHERE expires_at > ? ORDER BY sent_at ASC, id ASC",
                arguments: [Int64(clamping: now)]
            ).map(Self.storyItem)
        }
    }

    func allStories() async throws -> [StoryItem] {
        try await db.read { db in try Self.allStories(in: db) }
    }

    static func allStories(in db: Database) throws -> [StoryItem] {
        try Row.fetchAll(db, sql: "SELECT * FROM story_entries ORDER BY sent_at ASC, id ASC")
            .map(Self.storyItem)
    }

    func undeliveredStories() async throws -> [StoryItem] {
        try await db.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM story_entries WHERE undelivered != 0 ORDER BY sent_at ASC, id ASC")
                .map(Self.storyItem)
        }
    }

    @discardableResult
    func insertStoryItem(_ item: StoryItem, undelivered: Bool = false) async throws -> Bool {
        try await db.write { db in
            try Self.insertStoryItem(item, undelivered: undelivered, in: db)
        }
    }

    @discardableResult
    static func insertStoryItem(_ item: StoryItem, undelivered: Bool = false, in db: Database) throws -> Bool {
        if try isErased(item.id, in: db) || existsStory(item.id, in: db) {
            return false
        }
        let expiry = storyExpiresAt(sentAt: item.sentAt)
        try db.execute(sql: """
            INSERT INTO story_entries (
                id, author_user_id, sent_at, expires_at, content,
                media_ref, content_key, nonce, media_type, caption_meta, undelivered
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, arguments: [
            item.id.storedText,
            item.authorUserId.storedText,
            Int64(clamping: item.sentAt),
            Int64(clamping: expiry),
            item.content.storedText,
            item.attachment?.id.storedText,
            item.attachment?.contentKey,
            item.attachment?.nonce,
            item.attachment?.mediaType.storedText,
            item.captionMeta?.storedText,
            undelivered ? 1 : 0,
        ])
        return true
    }

    func setStoryUndelivered(id: String, undelivered: Bool) async throws {
        try await db.write { db in
            try db.execute(sql: "UPDATE story_entries SET undelivered = ? WHERE id = ?",
                           arguments: [undelivered ? 1 : 0, id.storedText])
        }
    }

    // MARK: - Profile entries

    func profiles() async throws -> [ProfileItem] {
        try await db.read { db in try Self.profiles(in: db) }
    }

    static func profiles(in db: Database) throws -> [ProfileItem] {
        try Row.fetchAll(db, sql: "SELECT * FROM profile_entries ORDER BY user_id ASC")
            .map(Self.profileItem)
    }

    func profile(userId: String) async throws -> ProfileItem? {
        try await db.read { db in try Self.profile(userId: userId, in: db) }
    }

    static func profile(userId: String, in db: Database) throws -> ProfileItem? {
        try Row.fetchOne(db, sql: "SELECT * FROM profile_entries WHERE user_id = ?",
                         arguments: [userId.storedText]).map(Self.profileItem)
    }

    func undeliveredProfiles() async throws -> [ProfileItem] {
        try await db.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM profile_entries WHERE undelivered != 0 ORDER BY user_id ASC")
                .map(Self.profileItem)
        }
    }

    @discardableResult
    func upsertProfile(_ item: ProfileItem, undelivered: Bool = false) async throws -> Bool {
        try await db.write { db in
            try Self.upsertProfile(item, undelivered: undelivered, in: db)
        }
    }

    @discardableResult
    static func upsertProfile(_ item: ProfileItem, undelivered: Bool = false, in db: Database) throws -> Bool {
        if let existing = try profile(userId: item.userId, in: db) {
            let wins = item.updatedAt > existing.updatedAt
                || (item.updatedAt == existing.updatedAt && item.authorDeviceId > existing.authorDeviceId)
            if !wins { return false }
        }
        try db.execute(sql: """
            INSERT OR REPLACE INTO profile_entries (
                user_id, author_device_id, updated_at, display_name, bio, undelivered
            ) VALUES (?, ?, ?, ?, ?, ?)
        """, arguments: [
            item.userId.storedText,
            item.authorDeviceId.storedText,
            Int64(clamping: item.updatedAt),
            item.displayName.storedText,
            item.bio.storedText,
            undelivered ? 1 : 0,
        ])
        return true
    }

    func setProfileUndelivered(userId: String, updatedAt: UInt64, undelivered: Bool) async throws {
        try await db.write { db in
            try db.execute(sql: "UPDATE profile_entries SET undelivered = ? WHERE user_id = ? AND updated_at = ?",
                           arguments: [undelivered ? 1 : 0, userId.storedText, Int64(clamping: updatedAt)])
        }
    }

    // MARK: - Expiry sweep

    func sweepExpired(now: UInt64) async throws -> (purgedMediaRefs: [String], touchedModels: [String]) {
        let nowClamped = Int64(clamping: now)
        let result: (purgedMediaRefs: [String], touchedModels: [String], deletedAny: Bool) = try await db.write { db in
            try db.execute(sql: "PRAGMA secure_delete = ON")
            var purgedMediaRefs: [String] = []
            var touchedSet: Set<String> = []
            var touchedModels: [String] = []
            func markTouched(_ model: String) {
                if touchedSet.insert(model).inserted {
                    touchedModels.append(model)
                }
            }

            let expiredConvRows = try Row.fetchAll(
                db,
                sql: "SELECT id, kind, media_ref FROM conversation_entries WHERE expires_at <= ?",
                arguments: [nowClamped]
            )
            for row in expiredConvRows {
                let id = try row.text("id")
                let kind: String = row["kind"]
                if let mediaRef = try row.optionalText("media_ref"), !mediaRef.isEmpty {
                    purgedMediaRefs.append(mediaRef)
                }
                markTouched(kind == "pix" ? "pix" : "directMessage")
                try db.execute(
                    sql: "INSERT OR REPLACE INTO erased_entries (id, erased_at) VALUES (?, ?)",
                    arguments: [id.storedText, nowClamped]
                )
            }
            if !expiredConvRows.isEmpty {
                try db.execute(sql: "DELETE FROM conversation_entries WHERE expires_at <= ?", arguments: [nowClamped])
            }

            let expiredStoryRows = try Row.fetchAll(
                db,
                sql: "SELECT id, media_ref FROM story_entries WHERE expires_at <= ?",
                arguments: [nowClamped]
            )
            for row in expiredStoryRows {
                let id = try row.text("id")
                if let mediaRef = try row.optionalText("media_ref"), !mediaRef.isEmpty {
                    purgedMediaRefs.append(mediaRef)
                }
                markTouched("story")
                try db.execute(
                    sql: "INSERT OR REPLACE INTO erased_entries (id, erased_at) VALUES (?, ?)",
                    arguments: [id.storedText, nowClamped]
                )
            }
            if !expiredStoryRows.isEmpty {
                try db.execute(sql: "DELETE FROM story_entries WHERE expires_at <= ?", arguments: [nowClamped])
            }

            var deletedTombstones = 0
            if now >= Self.maxEphemeralAgeMs {
                let cutoff = Int64(clamping: now - Self.maxEphemeralAgeMs)
                try db.execute(sql: "DELETE FROM erased_entries WHERE erased_at <= ?", arguments: [cutoff])
                deletedTombstones = db.changesCount
            }

            let deletedAny = !expiredConvRows.isEmpty || !expiredStoryRows.isEmpty || deletedTombstones > 0
            return (purgedMediaRefs, touchedModels, deletedAny)
        }
        if result.deletedAny {
            try await ObscuraDatabase.truncateWAL(db)
        }
        return (result.purgedMediaRefs, result.touchedModels)
    }

    // MARK: - History snapshot export & import

    func snapshot() async throws -> Obscura_Client_V1_EntrySnapshot {
        try await db.read { db in
            var snapshot = Obscura_Client_V1_EntrySnapshot()
            snapshot.messages = try Self.messages(in: db).map(\.snapshotRecord)
            snapshot.stories = try Self.allStories(in: db).map(\.snapshotRecord)
            snapshot.profiles = try Self.profiles(in: db).map(\.snapshotRecord)
            return snapshot
        }
    }

    func importSnapshot(_ snapshot: Obscura_Client_V1_EntrySnapshot) async throws {
        try await db.write { db in
            for record in snapshot.messages {
                guard !record.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !record.peerUserID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !record.authorUserID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let kind = record.kind.isEmpty ? "message" : record.kind
                let viewedAt = record.viewedAt > 0 ? record.viewedAt : nil
                let item: ConversationItem
                if kind == "pix" {
                    guard record.hasAttachment, let attachment = MediaAttachment(proto: record.attachment) else { continue }
                    item = .pix(
                        id: record.id,
                        peerUserId: record.peerUserID,
                        authorUserId: record.authorUserID,
                        sentAt: record.sentAt,
                        attachment: attachment,
                        caption: record.caption,
                        captionMeta: record.captionMeta,
                        displayDuration: Int(record.displayDurationSecs),
                        viewedAt: viewedAt
                    )
                } else {
                    item = .message(
                        id: record.id,
                        peerUserId: record.peerUserID,
                        authorUserId: record.authorUserID,
                        sentAt: record.sentAt,
                        content: record.content,
                        viewedAt: viewedAt
                    )
                }
                _ = try Self.insertConversationItem(item, undelivered: false, in: db)
            }
            for record in snapshot.stories {
                guard !record.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !record.authorUserID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let attachment = record.hasAttachment ? MediaAttachment(proto: record.attachment) : nil
                let item = StoryItem(
                    id: record.id,
                    authorUserId: record.authorUserID,
                    sentAt: record.sentAt,
                    content: record.content,
                    attachment: attachment,
                    captionMeta: record.captionMeta
                )
                _ = try Self.insertStoryItem(item, undelivered: false, in: db)
            }
            for record in snapshot.profiles {
                guard !record.userID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let item = ProfileItem(
                    userId: record.userID,
                    authorDeviceId: record.authorDeviceID,
                    updatedAt: record.updatedAt,
                    displayName: record.displayName,
                    bio: record.bio
                )
                _ = try Self.upsertProfile(item, undelivered: false, in: db)
            }
        }
    }

    // MARK: - Helpers

    private static func isErased(_ id: String, in db: Database) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM erased_entries WHERE id = ?)",
                          arguments: [id.storedText]) == true
    }

    private static func existsConversation(_ id: String, in db: Database) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM conversation_entries WHERE id = ?)",
                          arguments: [id.storedText]) == true
    }

    private static func existsStory(_ id: String, in db: Database) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT EXISTS(SELECT 1 FROM story_entries WHERE id = ?)",
                          arguments: [id.storedText]) == true
    }

    private static func mediaAttachment(_ row: Row) throws -> MediaAttachment? {
        guard let id = try row.optionalText("media_ref"), !id.isEmpty else {
            return nil
        }
        let contentKey = (row["content_key"] as Data?) ?? Data()
        let nonce = (row["nonce"] as Data?) ?? Data()
        let mediaType = try row.optionalText("media_type") ?? "photo"
        return MediaAttachment(id: id, contentKey: contentKey, nonce: nonce, mediaType: mediaType)
    }

    private static func conversationItem(_ row: Row) throws -> ConversationItem {
        let viewedRaw: Int64? = row["viewed_at"]
        let kind: String = row["kind"]
        let isPix = kind == "pix"
        return ConversationItem(
            id: try row.text("id"),
            peerUserId: try row.text("peer_user_id"),
            kind: kind,
            authorUserId: try row.text("author_user_id"),
            sentAt: UInt64(max(0, row["sent_at"] as Int64)),
            viewedAt: viewedRaw.map { UInt64(max(0, $0)) },
            content: try row.text("content"),
            attachment: isPix ? try mediaAttachment(row) : nil,
            caption: isPix ? try row.optionalText("caption") : nil,
            captionMeta: isPix ? try row.optionalText("caption_meta") : nil,
            displayDuration: isPix ? max(0, row["display_duration"] as Int) : 0
        )
    }

    private static func storyItem(_ row: Row) throws -> StoryItem {
        StoryItem(
            id: try row.text("id"),
            authorUserId: try row.text("author_user_id"),
            sentAt: UInt64(max(0, row["sent_at"] as Int64)),
            content: try row.text("content"),
            attachment: try mediaAttachment(row),
            captionMeta: try row.optionalText("caption_meta")
        )
    }

    private static func profileItem(_ row: Row) throws -> ProfileItem {
        ProfileItem(
            userId: try row.text("user_id"),
            authorDeviceId: try row.text("author_device_id"),
            updatedAt: UInt64(max(0, row["updated_at"] as Int64)),
            displayName: try row.text("display_name"),
            bio: try row.text("bio")
        )
    }
}
