import XCTest
import GRDB
@testable import ObscuraKit

/// Typed content storage: messages, pix, seen receipts, stories, profiles, expiry sweeps, tombstones,
/// snapshot export/import, and secure deletion.
final class ContentStoreTests: XCTestCase {

    private func makeStore() throws -> ContentStore {
        ContentStore(db: try ObscuraDatabase.inMemory())
    }

    private func message(
        _ id: String,
        peer: String = "user_b",
        author: String = "user_a",
        sentAt: UInt64 = 1_000,
        content: String = "hi"
    ) -> ConversationItem {
        ConversationItem(
            id: id,
            peerUserId: peer,
            kind: "message",
            authorUserId: author,
            sentAt: sentAt,
            viewedAt: nil,
            content: content,
            attachment: nil,
            caption: nil,
            captionMeta: nil,
            displayDuration: 0
        )
    }

    func testInsertConversationItemIsAppendOnlyAndOrderedBySentAtAndId() async throws {
        let store = try makeStore()
        let first = try await store.insertConversationItem(message("dm_2", sentAt: 2_000, content: "original"))
        let duplicate = try await store.insertConversationItem(message("dm_2", sentAt: 9_000, content: "tampered"))
        let earlier = try await store.insertConversationItem(message("dm_1", sentAt: 1_000, content: "earlier"))

        XCTAssertTrue(first)
        XCTAssertFalse(duplicate, "APPEND keeps the first write")
        XCTAssertTrue(earlier)

        let all = try await store.messages()
        XCTAssertEqual(all.map(\.id), ["dm_1", "dm_2"])
        XCTAssertEqual(all.last?.content, "original")
    }

    func testProfileUpsertOrdersByUpdatedAtThenAuthorDeviceId() async throws {
        let store = try makeStore()
        let initial = try await store.upsertProfile(ProfileItem(
            userId: "u1", authorDeviceId: "dev_b", updatedAt: 1_000, displayName: "B", bio: "1"
        ))
        let stale = try await store.upsertProfile(ProfileItem(
            userId: "u1", authorDeviceId: "dev_z", updatedAt: 900, displayName: "Stale", bio: "0"
        ))
        let tieLoser = try await store.upsertProfile(ProfileItem(
            userId: "u1", authorDeviceId: "dev_a", updatedAt: 1_000, displayName: "TieLoser", bio: "1"
        ))
        let tieWinner = try await store.upsertProfile(ProfileItem(
            userId: "u1", authorDeviceId: "dev_c", updatedAt: 1_000, displayName: "TieWinner", bio: "2"
        ))
        let newer = try await store.upsertProfile(ProfileItem(
            userId: "u1", authorDeviceId: "dev_a", updatedAt: 2_000, displayName: "Newer", bio: "3"
        ))

        XCTAssertTrue(initial)
        XCTAssertFalse(stale)
        XCTAssertFalse(tieLoser)
        XCTAssertTrue(tieWinner)
        XCTAssertTrue(newer)

        let profiles = try await store.profiles()
        XCTAssertEqual(profiles, [
            ProfileItem(userId: "u1", authorDeviceId: "dev_a", updatedAt: 2_000, displayName: "Newer", bio: "3"),
        ])
    }

    func testTextWithEmbeddedNULAndAwkwardCharactersRoundTripsExactlyThroughEveryPath() async throws {
        let awkward = "opaque\0bytes?\u{1}\u{7F}\u{FFFF}\u{FEFF}\u{200D}👩‍👩‍👧\r\n\\%_'\""
        let source = try makeStore()
        let msg = ConversationItem(
            id: "id\0\(awkward)", peerUserId: "peer\0x", kind: "message", authorUserId: "user\0x",
            sentAt: 7, viewedAt: nil, content: awkward, attachment: nil,
            caption: nil, captionMeta: nil, displayDuration: 0
        )
        let other = message("id", peer: "peer", author: "u", sentAt: 1, content: "truncated id must not collide")
        try await source.insertConversationItem(msg)
        try await source.insertConversationItem(other)

        let all = try await source.messages()
        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all.first { $0.id == msg.id }, msg)

        let snapshot = try await source.snapshot()
        let target = try makeStore()
        try await target.importSnapshot(Obscura_Client_V1_EntrySnapshot(serializedBytes: snapshot.serializedData()))
        let imported = try await target.messages()
        XCTAssertEqual(imported.first { $0.id == msg.id }, msg)
    }

    func testSweepExpiresSeenMessagesUnseenMaxAgeStoriesAndTombstones() async throws {
        let store = try makeStore()
        let t0: UInt64 = 1_000_000
        try await store.insertConversationItem(ConversationItem(
            id: "pix_seen", peerUserId: "peer", kind: "pix", authorUserId: "peer",
            sentAt: t0, viewedAt: nil, content: "",
            attachment: MediaAttachment(id: "att_pix", contentKey: Data([1]), nonce: Data([2]), mediaType: "photo"),
            caption: "hi", captionMeta: nil, displayDuration: 5
        ))
        try await store.insertConversationItem(message("dm_unseen", peer: "peer", author: "peer", sentAt: t0))
        try await store.insertStoryItem(StoryItem(
            id: "story_1", authorUserId: "peer", sentAt: t0, content: "s",
            attachment: MediaAttachment(id: "att_story", contentKey: Data([1]), nonce: Data([2]), mediaType: "photo"),
            captionMeta: nil
        ))

        let viewedAt = t0 + 10_000
        _ = try await store.markSeenLocal(entryId: "pix_seen", selfUserId: "self", viewedAt: viewedAt)

        // Before 15m after seen: nothing expires.
        let beforeSeenExpiry = try await store.sweepExpired(now: viewedAt + ContentStore.expireAfterViewMs - 1)
        XCTAssertEqual(beforeSeenExpiry.purgedMediaRefs, [])
        XCTAssertEqual(beforeSeenExpiry.touchedModels, [])

        // At 15m after seen: pix_seen expires and leaves a tombstone.
        let atSeenExpiry = try await store.sweepExpired(now: viewedAt + ContentStore.expireAfterViewMs)
        XCTAssertEqual(atSeenExpiry.purgedMediaRefs, ["att_pix"])
        XCTAssertEqual(atSeenExpiry.touchedModels, ["pix"])
        let remainingMessages = try await store.messages()
        XCTAssertEqual(remainingMessages.map(\.id), ["dm_unseen"])

        // Re-inserting an erased entry is ignored because of the tombstone.
        let reinserted = try await store.insertConversationItem(message("pix_seen", sentAt: t0))
        XCTAssertFalse(reinserted)

        // At 24h after sent: story_1 expires.
        let atStoryExpiry = try await store.sweepExpired(now: t0 + ContentStore.storyMaxAgeMs)
        XCTAssertEqual(atStoryExpiry.purgedMediaRefs, ["att_story"])
        XCTAssertEqual(atStoryExpiry.touchedModels, ["story"])
        let liveStories = try await store.stories(now: t0 + ContentStore.storyMaxAgeMs)
        XCTAssertTrue(liveStories.isEmpty)

        // At 30d after sent: dm_unseen expires.
        let atMaxAge = try await store.sweepExpired(now: t0 + ContentStore.maxEphemeralAgeMs)
        XCTAssertEqual(atMaxAge.touchedModels, ["directMessage"])
        let afterMaxAge = try await store.messages()
        XCTAssertTrue(afterMaxAge.isEmpty)

        // Exact tombstone pruning boundary at now == maxEphemeralAgeMs: erased_at <= 0 is deleted, erased_at == 1 is kept.
        let boundaryDb = try ObscuraDatabase.inMemory()
        let boundaryStore = ContentStore(db: boundaryDb)
        XCTAssertNil(StoryItem(id: "s", authorUserId: "u", sentAt: 1, content: "c", captionMeta: "").captionMeta)
        XCTAssertEqual(StoryItem(id: "s", authorUserId: "u", sentAt: 1, content: "c", captionMeta: "m").captionMeta, "m")
        _ = try await boundaryStore.insertConversationItem(message("tomb_0", sentAt: 0))
        _ = try await boundaryStore.insertConversationItem(message("tomb_1", sentAt: 1))
        _ = try await boundaryStore.sweepExpired(now: ContentStore.maxEphemeralAgeMs)
        let reinsertAtZero = try await boundaryStore.insertConversationItem(message("tomb_0", sentAt: 10))
        XCTAssertFalse(reinsertAtZero, "tomb_0 was just erased at maxEphemeralAgeMs")
        try await boundaryDb.write { db in
            try db.execute(
                sql: "INSERT INTO erased_entries (id, erased_at) VALUES (?, 0), (?, 1)",
                arguments: ["tomb_zero".storedText, "tomb_one".storedText]
            )
        }
        _ = try await boundaryStore.sweepExpired(now: ContentStore.maxEphemeralAgeMs - 1)
        let zeroBeforeBoundary = try await boundaryStore.insertConversationItem(message("tomb_zero", sentAt: 10))
        XCTAssertFalse(zeroBeforeBoundary)
        _ = try await boundaryStore.sweepExpired(now: ContentStore.maxEphemeralAgeMs)
        let zeroAtBoundary = try await boundaryStore.insertConversationItem(message("tomb_zero", sentAt: 10))
        let oneAtBoundary = try await boundaryStore.insertConversationItem(message("tomb_one", sentAt: 10))
        XCTAssertTrue(zeroAtBoundary, "erased_at == 0 is pruned at now == maxEphemeralAgeMs")
        XCTAssertFalse(oneAtBoundary, "erased_at == 1 is retained at now == maxEphemeralAgeMs")

        // At 30d after tombstone creation: old tombstones in erased_entries are cleaned up.
        let afterTombstoneMaxAge = try await store.sweepExpired(
            now: viewedAt + ContentStore.expireAfterViewMs + ContentStore.maxEphemeralAgeMs
        )
        XCTAssertEqual(afterTombstoneMaxAge.purgedMediaRefs, [])
    }

    func testSnapshotExportAndImportRoundTripsAllTables() async throws {
        let source = try makeStore()
        let att = MediaAttachment(id: "att_1", contentKey: Data([1, 2, 3]), nonce: Data([4, 5, 6]), mediaType: "video")
        try await source.insertConversationItem(ConversationItem(
            id: "pix_1", peerUserId: "peer_1", kind: "pix", authorUserId: "peer_1",
            sentAt: 1_000, viewedAt: 1_500, content: "", attachment: att,
            caption: "hello pix", captionMeta: "{\"y\":0.5}", displayDuration: 8
        ))
        try await source.insertStoryItem(StoryItem(
            id: "story_1", authorUserId: "peer_1", sentAt: 2_000, content: "story text",
            attachment: att, captionMeta: "{\"y\":0.2}"
        ))
        try await source.upsertProfile(ProfileItem(
            userId: "peer_1", authorDeviceId: "dev_1", updatedAt: 3_000, displayName: "Peer", bio: "Bio"
        ))

        let exported = try await source.snapshot()
        XCTAssertEqual(exported.messages.count, 1)
        XCTAssertEqual(exported.messages[0].attachment.id, "att_1")
        XCTAssertEqual(exported.stories.count, 1)
        XCTAssertEqual(exported.stories[0].attachment.id, "att_1")
        XCTAssertEqual(exported.profiles.count, 1)

        let target = try makeStore()
        try await target.importSnapshot(exported)

        let pix1 = try await target.message(id: "pix_1")
        XCTAssertEqual(pix1?.viewedAt, 1_500)
        XCTAssertEqual(pix1?.attachment, att)
        XCTAssertEqual(pix1?.caption, "hello pix")
        XCTAssertEqual(pix1?.captionMeta, "{\"y\":0.5}")
        XCTAssertEqual(pix1?.displayDuration, 8)

        let importedStories = try await target.allStories()
        XCTAssertEqual(importedStories.map(\.id), ["story_1"])
        XCTAssertEqual(importedStories.first?.attachment, att)
        let dupStory = try await target.insertStoryItem(importedStories[0])
        XCTAssertFalse(dupStory, "duplicate story is ignored")

        let importedProfile = try await target.profile(userId: "peer_1")
        XCTAssertEqual(importedProfile?.displayName, "Peer")
    }

    func testSnapshotImportSkipsBlankAndErasedRecordsAndDefaultsMediaType() async throws {
        var snapshot = Obscura_Client_V1_EntrySnapshot()

        var defaultKindMsg = Obscura_Client_V1_StoredMessageRecord()
        defaultKindMsg.id = "msg_default"
        defaultKindMsg.peerUserID = "peer_1"
        defaultKindMsg.authorUserID = "peer_1"
        defaultKindMsg.kind = ""
        defaultKindMsg.content = "default kind"

        var defaultMediaPix = Obscura_Client_V1_StoredMessageRecord()
        defaultMediaPix.id = "pix_default_media"
        defaultMediaPix.peerUserID = "peer_1"
        defaultMediaPix.authorUserID = "peer_1"
        defaultMediaPix.kind = "pix"
        defaultMediaPix.attachment.id = "att_2"
        defaultMediaPix.attachment.contentKey = Data([9])
        defaultMediaPix.attachment.nonce = Data([8])
        defaultMediaPix.attachment.mediaType = ""

        var erasedMsg = Obscura_Client_V1_StoredMessageRecord()
        erasedMsg.id = "erased_msg"
        erasedMsg.peerUserID = "peer_1"
        erasedMsg.authorUserID = "peer_1"
        erasedMsg.kind = "message"
        erasedMsg.content = "gone"

        var invalidBlankMsg = Obscura_Client_V1_StoredMessageRecord()
        invalidBlankMsg.id = "  "
        invalidBlankMsg.peerUserID = "peer_1"
        invalidBlankMsg.authorUserID = "peer_1"

        var invalidPixNoAtt = Obscura_Client_V1_StoredMessageRecord()
        invalidPixNoAtt.id = "pix_no_att"
        invalidPixNoAtt.peerUserID = "peer_1"
        invalidPixNoAtt.authorUserID = "peer_1"
        invalidPixNoAtt.kind = "pix"

        snapshot.messages = [defaultKindMsg, defaultMediaPix, erasedMsg, invalidBlankMsg, invalidPixNoAtt]

        var defaultMediaStory = Obscura_Client_V1_StoredStoryRecord()
        defaultMediaStory.id = "story_default_media"
        defaultMediaStory.authorUserID = "peer_1"
        defaultMediaStory.sentAt = 2_500
        defaultMediaStory.attachment.id = "att_s"
        defaultMediaStory.attachment.contentKey = Data([1])
        defaultMediaStory.attachment.nonce = Data([2])
        defaultMediaStory.attachment.mediaType = ""

        var invalidStory = Obscura_Client_V1_StoredStoryRecord()
        invalidStory.id = " "
        invalidStory.authorUserID = "peer_1"

        snapshot.stories = [defaultMediaStory, invalidStory]

        var invalidProfile = Obscura_Client_V1_StoredProfileRecord()
        invalidProfile.userID = "  "
        snapshot.profiles = [invalidProfile]

        let target = try makeStore()
        try await target.insertConversationItem(message("erased_msg", peer: "peer_1", author: "peer_1", sentAt: 100))
        _ = try await target.markSeenLocal(entryId: "erased_msg", selfUserId: "self", viewedAt: 100)
        _ = try await target.sweepExpired(now: 100 + ContentStore.expireAfterViewMs)

        try await target.importSnapshot(snapshot)

        let importedMessages = try await target.messages()
        XCTAssertEqual(importedMessages.map(\.id), ["msg_default", "pix_default_media"])
        let pixDefault = try await target.message(id: "pix_default_media")
        XCTAssertEqual(pixDefault?.attachment?.mediaType, "photo")

        let importedStories = try await target.allStories()
        XCTAssertEqual(importedStories.map(\.id), ["story_default_media"])
        XCTAssertEqual(importedStories.first?.attachment?.mediaType, "photo")

        let importedProfiles = try await target.profiles()
        XCTAssertTrue(importedProfiles.isEmpty)
    }

    func testUndeliveredFlagsTrackAndClearPendingItems() async throws {
        let store = try makeStore()
        try await store.insertConversationItem(message("m1", peer: "peer", author: "self", sentAt: 100), undelivered: true)
        try await store.insertConversationItem(message("m2", peer: "peer", author: "peer", sentAt: 200), undelivered: false)
        try await store.insertStoryItem(StoryItem(id: "s1", authorUserId: "self", sentAt: 100, content: "s"), undelivered: true)
        try await store.upsertProfile(ProfileItem(userId: "self", authorDeviceId: "d1", updatedAt: 100, displayName: "A", bio: "B"), undelivered: true)

        var undeliveredMsgs = try await store.undeliveredMessages()
        var undeliveredStories = try await store.undeliveredStories()
        var undeliveredProfiles = try await store.undeliveredProfiles()
        XCTAssertEqual(undeliveredMsgs.map(\.id), ["m1"])
        XCTAssertEqual(undeliveredStories.map(\.id), ["s1"])
        XCTAssertEqual(undeliveredProfiles.map(\.userId), ["self"])

        try await store.setMessageUndelivered(id: "m1", undelivered: false)
        try await store.setStoryUndelivered(id: "s1", undelivered: false)
        try await store.setProfileUndelivered(userId: "self", updatedAt: 100, undelivered: false)
        undeliveredMsgs = try await store.undeliveredMessages()
        undeliveredStories = try await store.undeliveredStories()
        undeliveredProfiles = try await store.undeliveredProfiles()
        XCTAssertTrue(undeliveredMsgs.isEmpty)
        XCTAssertTrue(undeliveredStories.isEmpty)
        XCTAssertTrue(undeliveredProfiles.isEmpty)
    }

    func testMarkSeenLocalMarksIncomingOnceAndIgnoresMissingOrOwn() async throws {
        let store = try makeStore()
        try await store.insertConversationItem(message("m1", peer: "peer", author: "self", sentAt: 100))
        try await store.insertConversationItem(message("m2", peer: "peer", author: "peer", sentAt: 200))

        let missingSeen = try await store.markSeenLocal(entryId: "missing", selfUserId: "self", viewedAt: 300)
        let ownSeen = try await store.markSeenLocal(entryId: "m1", selfUserId: "self", viewedAt: 300)
        let firstSeen = try await store.markSeenLocal(entryId: "m2", selfUserId: "self", viewedAt: 300)
        let secondSeen = try await store.markSeenLocal(entryId: "m2", selfUserId: "self", viewedAt: 400)
        XCTAssertNil(missingSeen)
        XCTAssertNil(ownSeen)
        XCTAssertEqual(firstSeen?.viewedAt, 300)
        XCTAssertNil(secondSeen)
    }

    func testSweepAndWipeZeroMainDatabaseAndTruncateWALWithSecureDeleteInitiallyOff() async throws {
        let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".wal-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("wal.db").path
        let db = try DatabaseQueue(path: path)
        try ObscuraDatabase.migrator.migrate(db)
        try await db.writeWithoutTransaction {
            XCTAssertEqual(try String.fetchOne($0, sql: "PRAGMA journal_mode = WAL"), "wal")
            try $0.execute(sql: "PRAGMA wal_autocheckpoint = 0; PRAGMA secure_delete = OFF")
        }
        let store = ContentStore(db: db)
        let secret = "WAL-ERASE-SECRET-7fa915"
        func contains(_ path: String, _ value: String) -> Bool {
            FileManager.default.contents(atPath: path)?.range(of: Data(value.utf8)) != nil
        }
        try await store.insertConversationItem(message(
            "erase", sentAt: 100, content: secret + String(repeating: "z", count: 6000)
        ))
        XCTAssertTrue(contains(path + "-wal", secret), "control: plaintext must occur in the WAL")
        try await db.writeWithoutTransaction { try $0.execute(sql: "PRAGMA wal_checkpoint(FULL)") }
        XCTAssertTrue(contains(path, secret), "control: plaintext must occur in the database")

        _ = try await store.sweepExpired(now: 100 + ContentStore.maxEphemeralAgeMs)
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, secret))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)

        // Story-only expiry and tombstone-only pruning also zero the main database and truncate the WAL.
        let storySecret = "WAL-STORY-SECRET-9bc112"
        try await store.insertStoryItem(StoryItem(
            id: "erase_story", authorUserId: "u", sentAt: 200,
            content: storySecret + String(repeating: "y", count: 6000)
        ))
        try await db.writeWithoutTransaction { try $0.execute(sql: "PRAGMA wal_checkpoint(FULL)") }
        XCTAssertTrue(contains(path, storySecret))
        _ = try await store.sweepExpired(now: 200 + ContentStore.storyMaxAgeMs)
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, storySecret))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)

        let tombSecret = "WAL-TOMB-SECRET-3de441" + String(repeating: "x", count: 6000)
        try await db.write { db in
            try db.execute(sql: "INSERT INTO erased_entries (id, erased_at) VALUES (?, 0)", arguments: [tombSecret.storedText])
        }
        try await db.writeWithoutTransaction { try $0.execute(sql: "PRAGMA wal_checkpoint(FULL)") }
        XCTAssertTrue(contains(path, "WAL-TOMB-SECRET-3de441"))
        _ = try await store.sweepExpired(now: ContentStore.maxEphemeralAgeMs)
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, "WAL-TOMB-SECRET-3de441"))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)

        try await store.insertConversationItem(message("wipe", sentAt: 200, content: secret))
        try await db.write { try $0.execute(sql: "PRAGMA secure_delete = OFF") }
        try await ObscuraDatabase.wipe(db)
        for file in [path, path + "-wal"] {
            XCTAssertFalse(contains(file, secret))
        }
        XCTAssertEqual(FileManager.default.contents(atPath: path + "-wal")?.count ?? 0, 0)
    }
}
