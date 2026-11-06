import XCTest
@testable import ObscuraKit

final class FriendTests: XCTestCase {
    func testAFriendCodeHandshakeAcceptsBothSidesWithTheirUsernames() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()
        try await bob.client.connect()

        try await alice.client.addFriendByCode(bob.client.friendCode())

        let asked = try await alice.client.friends.friend(bob.userId)
        XCTAssertEqual(asked?.status, .pendingSent)
        XCTAssertEqual(asked?.username, bob.username)
        try await bob.waitForFriend(alice, .pendingReceived)
        let asker = try await bob.client.friends.friend(alice.userId)
        XCTAssertEqual(asker?.username, alice.username)

        try await alice.client.connect()
        try await bob.client.acceptFriend(alice.userId)
        try await alice.waitForFriend(bob, .accepted)
        let aliceFriends = try await alice.client.getFriends()
        let bobFriends = try await bob.client.getFriends()
        XCTAssertEqual(aliceFriends.map(\.status), [.accepted])
        XCTAssertEqual(bobFriends.map(\.status), [.accepted])

        // Rescanning an accepted friend changes neither side.
        try await alice.client.befriend(bob.userId, username: bob.username)
        let again = try await alice.client.getFriends()
        XCTAssertEqual(again.map(\.status), [.accepted])
    }

    func testCrossedRequestsBecomeAFriendship() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()

        try await alice.client.befriend(bob.userId, username: bob.username)
        try await bob.client.befriend(alice.userId, username: alice.username)
        try await alice.client.connect()

        try await alice.waitForFriend(bob, .accepted)
    }

    func testAFriendRequestSentWhileOfflineArrivesOnConnect() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()

        try await alice.client.befriend(bob.userId, username: bob.username)
        try await bob.client.connect()

        try await bob.waitForFriend(alice, .pendingReceived)
    }

    func testAnAcceptedFriendCannotRenameItselfOrResetItsStatus() async throws {
        let (alice, mallory) = try await TestUser.friends()
        var spoof = Obscura_Client_V1_ClientMessage()
        spoof.friendRequest.username = "Mum"

        try await mallory.sendRaw(spoof, to: alice)
        try await mallory.send("marker", to: [alice])
        _ = try await alice.waitForEntry("marker")

        let record = try await alice.client.friends.friend(mallory.userId)
        XCTAssertEqual(record?.username, mallory.username)
        XCTAssertEqual(record?.status, .accepted)
    }

    func testAStrangerCannotSelfAcceptIntoTheFriendGraph() async throws {
        let alice = try await TestUser.register()
        let stranger = try await TestUser.register()
        try await alice.client.connect()
        var forged = Obscura_Client_V1_ClientMessage()
        forged.friendAccept = Obscura_Client_V1_FriendAccept()

        try await stranger.sendRaw(forged, to: alice)
        try await stranger.send("marker", to: [alice])
        _ = try await alice.waitForEntry("marker")

        let injected = try await alice.client.friends.friend(stranger.userId)
        XCTAssertNil(injected)
    }

    func testRemovingAFriendForgetsThemLocally() async throws {
        let (alice, bob) = try await TestUser.friends()

        try await alice.client.removeFriend(bob.userId)

        let friends = try await alice.client.getFriends()
        let devices = try await alice.client.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(friends, [])
        XCTAssertEqual(devices, [])
    }
}
