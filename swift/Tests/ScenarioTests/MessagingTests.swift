import XCTest
@testable import ObscuraKit

final class MessagingTests: XCTestCase {
    func testADirectMessageArrivesAndStoresLocallyOnBothSides() async throws {
        let (alice, bob) = try await TestUser.friends()

        let id = try await alice.client.sendMessage(peerUserId: bob.userId, content: "hello bob")

        let row = try await bob.waitForEntry(id)
        XCTAssertEqual(row.kind, "message")
        XCTAssertEqual(row.content, "hello bob")
        XCTAssertEqual(row.authorUserId, alice.userId)
        XCTAssertEqual(row.peerUserId, alice.userId)
        let aliceMessages = try await alice.client.getMessages()
        XCTAssertEqual(aliceMessages.map(\.id), [id])
        XCTAssertEqual(aliceMessages.first?.peerUserId, bob.userId)
    }

    func testEachNewEntryWakesTheSingleMessageStreamOnce() async throws {
        let (alice, bob) = try await TestUser.friends()
        var wakes = bob.client.messageReceived.makeAsyncIterator()

        _ = try await alice.client.sendMessage(peerUserId: bob.userId, content: "one")
        _ = try await alice.client.postStory(content: "two", attachment: nil, captionMeta: nil)

        let first = await wakes.next()
        let second = await wakes.next()
        XCTAssertEqual([first, second], ["directMessage", "story"])
    }

    func testEntriesQueuedWhileOfflineArriveOnConnect() async throws {
        let (alice, bob) = try await TestUser.friends()
        await bob.client.disconnect()

        try await alice.send("offline-1", to: [bob])
        try await alice.send("offline-2", to: [bob])
        try await bob.client.connect()

        _ = try await bob.waitForEntry("offline-1")
        _ = try await bob.waitForEntry("offline-2")
    }

    func testEveryDeviceOfARecipientReceives() async throws {
        let bob = try await TestUser.register()
        let bobLaptop = try await TestUser.link(to: bob)
        let alice = try await TestUser.register()
        try await bob.client.connect()
        try await alice.client.connect()
        try await TestUser.befriend(alice, bob)
        try await bobLaptop.waitForFriend(alice, .accepted)

        try await alice.send("both-bobs", to: [bob])
        _ = try await bob.waitForEntry("both-bobs")
        _ = try await bobLaptop.waitForEntry("both-bobs")

        await alice.client.disconnect()
        try await alice.client.connect()
        try await alice.send("after-reconnect", to: [bob])
        _ = try await bob.waitForEntry("after-reconnect")
        _ = try await bobLaptop.waitForEntry("after-reconnect")
    }

    func testAnEmptyRecipientListSyncsToTheUsersOtherDevices() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice)
        try await alice.client.connect()

        let report = try await alice.send("dm_sync_1", to: [])

        XCTAssertEqual(report.recipients, [])
        XCTAssertEqual(report.selfSync.map(\.deviceId), [laptop.deviceId])
        let row = try await laptop.waitForEntry("dm_sync_1")
        XCTAssertEqual(row.authorUserId, alice.userId)
    }

    func testEncryptedAttachmentsRoundTripAndTheServerOnlySeesCiphertext() async throws {
        let (alice, bob) = try await TestUser.friends()
        let image = Data([0xFF, 0xD8, 0xFF, 0xE0]) + Data((0..<(500 * 1024)).map { UInt8($0 % 256) })

        let uploaded = try await alice.client.uploadAttachment(image)
        let storyId = try await alice.client.postStory(
            content: "caption", attachment: uploaded.media("photo"), captionMeta: nil
        )

        let story = try await bob.waitForStory(storyId)
        let att = try XCTUnwrap(story.attachment)
        let downloaded = try await bob.client.downloadDecryptedAttachment(
            id: att.id,
            contentKey: att.contentKey,
            nonce: att.nonce
        )
        XCTAssertEqual(downloaded, image)
        let ciphertext = try await bob.client.api.fetchAttachment(uploaded.id)
        XCTAssertNotEqual(ciphertext.prefix(4), image.prefix(4))
    }

    func testRegisteringAPushTokenIsIdempotent() async throws {
        let alice = try await TestUser.register()
        let token = "test-apns-token-\(UUID().uuidString)"

        try await alice.client.registerPushToken(token)
        try await alice.client.registerPushToken(token)
        try await alice.client.registerPushToken("test-apns-token-\(UUID().uuidString)")
    }
}
