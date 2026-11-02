import XCTest
@testable import ObscuraKit

final class MessagingTests: XCTestCase {
    func testAnEntryArrivesUntouchedAttributedToTheSendersDeviceAndNotToTheSender() async throws {
        let (alice, bob) = try await TestUser.friends()
        let payload = Data(#"{"content":"opaque to the kit","expiresAt":123}"#.utf8)

        let report = try await alice.send("dm_1", to: [bob], model: "directMessage", payload: payload)

        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        XCTAssertEqual(report.selfSync, [], "a single-device sender has no other device to sync")
        let row = try await bob.waitForEntry("dm_1")
        XCTAssertEqual(row.modelKey, "directMessage")
        XCTAssertEqual(row.payload, payload)
        XCTAssertEqual(row.senderUserId, alice.userId)
        XCTAssertEqual(row.senderDeviceId, alice.deviceId)
        let aliceDepth = try await alice.client.inbox.depth()
        let aliceEntries = try await alice.client.entries.all(model: "directMessage")
        XCTAssertEqual(aliceDepth, 0, "the sending device does not receive its own entry")
        XCTAssertEqual(aliceEntries, [], "send stores nothing locally; the app writes its own copy")
    }

    func testEachNewEntryWakesTheSingleMessageStreamOnce() async throws {
        let (alice, bob) = try await TestUser.friends()
        var wakes = bob.client.messageReceived.makeAsyncIterator()

        try await alice.send("one", to: [bob], model: "model-a")
        try await alice.send("two", to: [bob], model: "model-b")

        let first = await wakes.next()
        let second = await wakes.next()
        XCTAssertEqual([first, second], ["model-a", "model-b"])
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

        let report = try await alice.send("profile_1", to: [], model: "profile")

        XCTAssertEqual(report.recipients, [])
        XCTAssertEqual(report.selfSync.map(\.deviceId), [laptop.deviceId])
        let row = try await laptop.waitForEntry("profile_1")
        XCTAssertEqual(row.senderDeviceId, alice.deviceId)
        let aliceDepth = try await alice.client.inbox.depth()
        XCTAssertEqual(aliceDepth, 0)
    }

    func testEncryptedAttachmentsRoundTripAndTheServerOnlySeesCiphertext() async throws {
        let (alice, bob) = try await TestUser.friends()
        let image = Data([0xFF, 0xD8, 0xFF, 0xE0]) + Data((0..<(500 * 1024)).map { UInt8($0 % 256) })

        let uploaded = try await alice.client.uploadAttachment(image)
        let payload = try JSONSerialization.data(withJSONObject: [
            "mediaRef": uploaded.id, "key": uploaded.contentKey.base64EncodedString(),
            "nonce": uploaded.nonce.base64EncodedString(),
        ])
        try await alice.send("story_media", to: [bob], model: "story", payload: payload)

        let row = try await bob.waitForEntry("story_media")
        let reference = try XCTUnwrap(JSONSerialization.jsonObject(with: row.payload) as? [String: String])
        let downloaded = try await bob.client.downloadDecryptedAttachment(
            id: try XCTUnwrap(reference["mediaRef"]), contentKey: try XCTUnwrap(Data(base64Encoded: reference["key"]!)),
            nonce: try XCTUnwrap(Data(base64Encoded: reference["nonce"]!)))
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
