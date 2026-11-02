import Foundation
import LibSignalClient
import XCTest
@testable import ObscuraKit

/// One account on a primary (`phone`) and a linked device (`laptop`): who may change the friend
/// list, how it reaches linked devices, and unlinking.
final class MultiDeviceTests: XCTestCase {
    private var server: FakeObscuraServer!
    private var phone: FakeDevice!
    private var laptop: FakeDevice!
    private var bob: FakeDevice!
    private var phoneClient: ObscuraClient!
    private var laptopClient: ObscuraClient!

    override func setUp() async throws {
        server = FakeObscuraServer()
        let alice = UUID().uuidString.lowercased()
        phone = try await server.register(alice)
        laptop = try await server.register(alice)
        bob = try await server.register(UUID().uuidString.lowercased())
        phoneClient = try await authenticatedClient(phone, username: "alice")
        laptopClient = try await authenticatedClient(laptop, username: "alice")
    }

    override func tearDown() async throws {
        try await phoneClient.logout()
        try await laptopClient.logout()
        server.close()
    }

    private func version(_ client: ObscuraClient) async throws -> UInt64 {
        try await client.db.read { try FriendStore.version(in: $0) }
    }

    private func sync(version: UInt64, _ friends: [(String, String, Obscura_Client_V1_FriendStatus)]) -> Obscura_Client_V1_ClientMessage {
        clientMessage {
            $0.friendListSync.version = version
            $0.friendListSync.friends = friends.map { userId, username, status in
                var record = Obscura_Client_V1_FriendRecord()
                record.userID = userId
                record.username = username
                record.status = status
                return record
            }
        }
    }

    // MARK: - The primary is the authority

    func testALinkedDeviceIsRefusedFriendChangesAndLinkApproval() async throws {
        let isPrimary = try await laptopClient.isPrimary
        XCTAssertFalse(isPrimary)
        try await laptopClient.friends.add(bob.userId, username: "bob", status: .pendingReceived)
        let code = try LinkCrypto.encode(linkCodeFixture())

        await assertThrows(.notPrimary) { try await self.laptopClient.addFriendByCode(FriendCode.encode(userId: "u", username: "n")) }
        await assertThrows(.notPrimary) { try await self.laptopClient.acceptFriend(self.bob.userId) }
        await assertThrows(.notPrimary) { try await self.laptopClient.removeFriend(self.bob.userId) }
        await assertThrows(.notPrimary) { try await self.laptopClient.approveLink(code) }
        let replies = try await bob.receive()
        XCTAssertTrue(replies.isEmpty)
    }

    func testALinkedDeviceAcknowledgesFriendRequestsAndAcceptsAndChangesNothing() async throws {
        try await send(clientMessage { $0.friendRequest.username = "bob" }, from: bob, to: phone.userId)
        try await send(clientMessage { $0.friendAccept = Obscura_Client_V1_FriendAccept() }, from: bob, to: phone.userId)

        let acks = await deliver(laptop, to: laptopClient)

        XCTAssertEqual(acks, 2)
        let friends = try await laptopClient.getFriends()
        XCTAssertEqual(friends, [])
        let held = try await version(laptopClient)
        XCTAssertEqual(held, 0)
        let replies = try await bob.receive()
        XCTAssertTrue(replies.isEmpty, "a linked device sends no reply")
    }

    func testEveryPrimaryFriendChangeBumpsTheVersionAndSendsTheWholeListToLinkedDevices() async throws {
        try await send(clientMessage { $0.friendRequest.username = "bob" }, from: bob, to: phone.userId)
        await deliver(phone, to: phoneClient)
        let afterRequest = try await version(phoneClient)
        XCTAssertEqual(afterRequest, 1)
        await deliver(laptop, to: laptopClient)
        var mirrored = try await laptopClient.getFriends()
        XCTAssertEqual(mirrored.map(\.userId), [bob.userId])
        XCTAssertEqual(mirrored.map(\.status), [.pendingReceived])

        try await phoneClient.acceptFriend(bob.userId)
        await deliver(laptop, to: laptopClient)
        mirrored = try await laptopClient.getFriends()
        XCTAssertEqual(mirrored.map(\.status), [.accepted])
        XCTAssertEqual(mirrored.map(\.username), ["bob"])

        try await phoneClient.removeFriend(bob.userId)
        await deliver(laptop, to: laptopClient)
        mirrored = try await laptopClient.getFriends()
        XCTAssertEqual(mirrored, [])
        let primaryVersion = try await version(phoneClient)
        let linkedVersion = try await version(laptopClient)
        XCTAssertEqual(primaryVersion, 3)
        XCTAssertEqual(linkedVersion, 3)
    }

    func testALinkedDeviceTakesOnlyANewerWellFormedListFromItsOwnPrimary() async throws {
        let tablet = try await server.register(phone.userId)
        try await send(sync(version: 5, [(bob.userId, "bob", .accepted)]), from: phone, to: phone.userId)
        await deliver(laptop, to: laptopClient)
        _ = tablet.envelopes()
        var friends = try await laptopClient.getFriends()
        XCTAssertEqual(friends.map(\.userId), [bob.userId])

        let ignored: [(Obscura_Client_V1_ClientMessage, FakeDevice)] = [
            (sync(version: 5, []), phone),
            (sync(version: 4, []), phone),
            (sync(version: 9, []), tablet),
            (sync(version: 9, []), bob),
            (sync(version: 10, [("someone", "x", .unspecified)]), phone),
        ]
        for (message, sender) in ignored {
            try await send(message, from: sender, to: phone.userId)
            let acks = await deliver(laptop, to: laptopClient)
            XCTAssertEqual(acks, 1)
        }

        friends = try await laptopClient.getFriends()
        XCTAssertEqual(friends.map(\.userId), [bob.userId])
        let held = try await version(laptopClient)
        XCTAssertEqual(held, 5)
    }

    func testThePrimaryIgnoresAFriendListSync() async throws {
        try await send(sync(version: 7, [(bob.userId, "bob", .accepted)]), from: laptop, to: phone.userId)

        let acks = await deliver(phone, to: phoneClient)

        XCTAssertEqual(acks, 1)
        let friends = try await phoneClient.getFriends()
        XCTAssertEqual(friends, [])
    }

    // MARK: - Unlinking

    func testThePrimaryUnlinksAnotherDeviceButNotItself() async throws {
        await assertThrows(.invalidArgument("the primary device cannot be unlinked; reset the account instead")) {
            try await self.phoneClient.unlinkDevice(self.phone.deviceId)
        }

        try await phoneClient.unlinkDevice(laptop.deviceId)

        let own = try await phoneClient.directory.deviceIds(of: phone.userId)
        XCTAssertEqual(own, [phone.deviceId])
        let devices = try await phoneClient.devices()
        XCTAssertEqual(devices.map(\.deviceId), [phone.deviceId])
    }

    func testALinkedDeviceUnlinksOnlyItselfThenIsWipedAndSignedOut() async throws {
        await assertThrows(.notPrimary) { try await self.laptopClient.unlinkDevice(self.phone.deviceId) }

        try await laptopClient.unlinkDevice(laptop.deviceId)

        XCTAssertEqual(laptopClient.authState, .loggedOut)
        XCTAssertFalse(try laptopClient.signalStore.hasIdentity())
        let localDevice = try await laptopClient.directory.localDeviceId()
        XCTAssertNil(localDevice)
        let devices = try await phoneClient.devices()
        XCTAssertEqual(devices.map(\.deviceId), [phone.deviceId])
    }

    func testARejectedTokenWhoseRefreshIsRejectedSignsOutAndThrowsNotAuthenticated() async throws {
        server.remove(laptop)

        await assertThrows(.notAuthenticated) { _ = try await self.laptopClient.devices() }

        XCTAssertEqual(laptopClient.authState, .loggedOut)
    }

    func testARejectedTokenIsRefreshedOnceAndTheRequestRetried() async throws {
        let fresh = phone.deviceId
        server.acceptRefresh(token: fresh, refreshToken: "rotated", userId: phone.userId, deviceId: phone.deviceId)
        server.rejectTokens(1)

        let devices = try await phoneClient.devices()

        XCTAssertEqual(devices.map(\.deviceId), [phone.deviceId, laptop.deviceId])
        XCTAssertEqual(phoneClient.authState, .authenticated)
        let session = await phoneClient.session
        XCTAssertEqual(session?.token, fresh)
        XCTAssertEqual(session?.refreshToken, "rotated")
    }

    func testADeviceUnlinkedElsewhereIsSignedOutWhenItsTokenIsRejected() async throws {
        server.remove(laptop)

        do { try await laptopClient.connect(); XCTFail("a deleted device cannot connect") } catch {}

        XCTAssertEqual(laptopClient.authState, .loggedOut)
        XCTAssertTrue(try laptopClient.signalStore.hasIdentity(), "signing out keeps local data")
    }
}

func linkCodeFixture(sessionId: String = "session",
                     publicKey: PublicKey = PrivateKey.generate().publicKey) -> Obscura_Client_V1_LinkCode {
    var code = Obscura_Client_V1_LinkCode()
    code.sessionID = sessionId
    code.ephemeralPublicKey = Data(publicKey.serialize())
    code.deviceName = "new device"
    return code
}
