import XCTest
@testable import ObscuraKit

/// One account on a primary and linked devices, against a real server.
final class MultiDeviceTests: XCTestCase {
    func testLinkedDevicesReceiveEveryMessageAndSyncTheirOwnWrites() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice, name: "laptop")
        let tablet = try await TestUser.link(to: alice, name: "tablet")
        let bob = try await TestUser.register()
        try await alice.client.connect()
        try await bob.client.connect()
        try await TestUser.befriend(bob, alice)

        let toAlice = try await bob.send("to-every-alice", to: [alice])
        XCTAssertEqual(Set(toAlice.recipients.map(\.deviceId)), [alice.deviceId, laptop.deviceId, tablet.deviceId])
        XCTAssertTrue(toAlice.recipients.allSatisfy { $0.status == .accepted })
        for device in [alice, laptop, tablet] { _ = try await device.waitForEntry("to-every-alice") }

        let fromLaptop = try await laptop.send("from-laptop", to: [bob])
        XCTAssertEqual(fromLaptop.recipients.map(\.status), [.accepted])
        XCTAssertEqual(Set(fromLaptop.selfSync.map(\.deviceId)), [alice.deviceId, tablet.deviceId])
        let atBob = try await bob.waitForEntry("from-laptop")
        XCTAssertEqual(atBob.senderUserId, alice.userId)
        XCTAssertEqual(atBob.senderDeviceId, laptop.deviceId)
        _ = try await alice.waitForEntry("from-laptop")
        _ = try await tablet.waitForEntry("from-laptop")
        XCTAssertTrue(bob.client.getDebugLog().filter { $0.hasPrefix("identity changed") }.isEmpty,
                      "linked devices share the account identity")
    }

    func testFriendChangesOnThePrimaryReachLinkedDevicesWhichCannotMakeThem() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice)
        let bob = try await TestUser.register()
        try await alice.client.connect()
        try await bob.client.connect()

        try await alice.client.addFriendByCode(bob.client.friendCode())
        try await laptop.waitForFriend(bob, .pendingSent)
        try await bob.waitForFriend(alice, .pendingReceived)
        try await bob.client.acceptFriend(alice.userId)
        try await alice.waitForFriend(bob, .accepted)
        try await laptop.waitForFriend(bob, .accepted)
        let mirrored = try await laptop.client.friends.friend(bob.userId)
        XCTAssertEqual(mirrored?.username, bob.username)

        let carol = try await TestUser.register()
        await assertThrows(.notPrimary) { try await laptop.client.addFriendByCode(carol.client.friendCode()) }
        await assertThrows(.notPrimary) { try await laptop.client.acceptFriend(bob.userId) }
        await assertThrows(.notPrimary) { try await laptop.client.removeFriend(bob.userId) }

        try await alice.client.removeFriend(bob.userId)
        _ = try await eventually("laptop forgets bob") {
            try await laptop.client.friends.friend(bob.userId) == nil ? true : nil
        }
    }

    func testAConnectedPrimaryReachesADeviceLinkedAfterItsLastConnect() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()
        try await alice.client.connect()
        try await bob.client.connect()
        let laptop = try await TestUser.link(to: alice, name: "laptop")
        let known = try await alice.client.directory.deviceIds(of: alice.userId)
        XCTAssertEqual(known, [alice.deviceId], "the primary has not seen the laptop")

        try await alice.client.addFriendByCode(bob.client.friendCode())
        try await laptop.waitForFriend(bob, .pendingSent)

        let report = try await alice.send("self-sync-after-link", to: [])
        XCTAssertEqual(report.selfSync.map(\.deviceId), [laptop.deviceId])
        XCTAssertEqual(report.selfSync.map(\.status), [.accepted])
        _ = try await laptop.waitForEntry("self-sync-after-link")
        XCTAssertEqual(alice.client.connectionState, .connected)
    }

    func testASendRightAfterAPeerResetReachesTheNewPrimaryInThatSend() async throws {
        let (alice, bob) = try await TestUser.friends()
        try await bob.send("warm", to: [alice])
        _ = try await alice.waitForEntry("warm")

        try await alice.client.resetAccount(alice.username, TestServer.password)
        let deviceId = await alice.client.deviceId
        let newDeviceId = try XCTUnwrap(deviceId)

        let report = try await bob.send("right-after-reset", to: [alice])

        XCTAssertEqual(report.recipients.map(\.deviceId), [newDeviceId])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        let known = try await bob.client.directory.deviceIds(of: alice.userId)
        XCTAssertEqual(known, [newDeviceId])
        try await alice.client.connect()
        _ = try await alice.waitForEntry("right-after-reset")
    }

    func testADeviceLinkedMidConversationIsReachedThroughTheMismatchResponse() async throws {
        let (alice, bob) = try await TestUser.friends()
        try await alice.send("before-link", to: [bob])
        _ = try await bob.waitForEntry("before-link")
        try await bob.send("reply-before-link", to: [alice])
        _ = try await alice.waitForEntry("reply-before-link")

        let tablet = try await TestUser.link(to: alice, name: "tablet")
        let known = try await bob.client.directory.deviceIds(of: alice.userId)
        XCTAssertEqual(known, [alice.deviceId])

        let report = try await bob.send("after-link", to: [alice])

        XCTAssertEqual(Set(report.recipients.map(\.deviceId)), [alice.deviceId, tablet.deviceId])
        XCTAssertTrue(report.recipients.allSatisfy { $0.status == .accepted })
        _ = try await tablet.waitForEntry("after-link")
        _ = try await alice.waitForEntry("after-link")
        let learned = try await bob.client.directory.deviceIds(of: alice.userId)
        XCTAssertEqual(Set(learned), [alice.deviceId, tablet.deviceId])
    }

    func testUnlinkedDevicesAreSignedOutAndTheirNextLoginIsAMismatch() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice, name: "laptop")
        let tablet = try await TestUser.link(to: alice, name: "tablet")

        try await alice.client.unlinkDevice(laptop.deviceId)
        await laptop.client.disconnect()
        await assertThrows(.notAuthenticated) { _ = try await laptop.client.devices() }
        XCTAssertEqual(laptop.client.authState, .loggedOut, "a rejected token and refresh sign the device out")
        let laptopLogin = try await laptop.client.login(alice.username, TestServer.password)
        XCTAssertEqual(laptopLogin, .deviceMismatch)

        try await tablet.client.unlinkDevice(tablet.deviceId)
        XCTAssertEqual(tablet.client.authState, .loggedOut)
        XCTAssertFalse(try tablet.client.signalStore.hasIdentity())

        let devices = try await alice.client.devices()
        XCTAssertEqual(devices.map(\.deviceId), [alice.deviceId])
        try await laptop.client.wipeDevice()
        let relink = try await laptop.client.login(alice.username, TestServer.password)
        XCTAssertEqual(relink, .linkRequired)
    }

    func testAPeerSeesAnAccountResetAsAnIdentityChangeAndReachesTheNewPrimary() async throws {
        let (alice, bob) = try await TestUser.friends()
        try await alice.send("before-reset", to: [bob])
        _ = try await bob.waitForEntry("before-reset")
        try await bob.send("reply-before-reset", to: [alice])
        _ = try await alice.waitForEntry("reply-before-reset")

        try await alice.client.resetAccount(alice.username, TestServer.password)
        let deviceId = await alice.client.deviceId
        let newDeviceId = try XCTUnwrap(deviceId)
        try await alice.client.connect()

        let report = try await bob.send("after-reset", to: [alice])

        XCTAssertEqual(report.recipients.map(\.deviceId), [newDeviceId])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        _ = try await alice.waitForEntry("after-reset")
        XCTAssertEqual(bob.client.getDebugLog().filter { $0.hasPrefix("identity changed") },
                       ["identity changed for \(alice.userId)"])
    }

    func testANewlyLinkedDeviceHasTheHistoryButNotTheLocalMetadata() async throws {
        let alice = try await TestUser.register()
        let story = StoredEntry(id: "s1", data: #"{"text":"hi"}"#, sentAt: 1_706_389_200_000,
                                authorUserId: alice.userId, authorDeviceId: alice.deviceId, localMetadata: "seen")
        let pix = StoredEntry(id: "p1", data: "opaque", sentAt: 1_706_389_300_000,
                              authorUserId: "some-peer-user", authorDeviceId: "some-peer-device", localMetadata: nil)
        try await alice.client.entries.put(model: "story", entry: story)
        try await alice.client.entries.put(model: "pix", entry: pix)

        let laptop = try await TestUser.link(to: alice)

        let stories = try await laptop.client.entries.all(model: "story")
        let pixes = try await laptop.client.entries.all(model: "pix")
        XCTAssertEqual(stories, [StoredEntry(id: story.id, data: story.data, sentAt: story.sentAt,
                                             authorUserId: story.authorUserId, authorDeviceId: story.authorDeviceId,
                                             localMetadata: nil)])
        XCTAssertEqual(pixes, [pix])
        await laptop.client.disconnect()
    }
}

func assertThrows(_ expected: ObscuraError, file: StaticString = #filePath, line: UInt = #line,
                  _ body: () async throws -> Void) async {
    do {
        try await body()
        XCTFail("expected \(expected)", file: file, line: line)
    } catch {
        XCTAssertEqual(error as? ObscuraError, expected, file: file, line: line)
    }
}
