import Foundation
import XCTest
@testable import ObscuraKit

/// The client's local contract: guards, and how each received payload class is handled.
final class ClientTests: XCTestCase {
    private var server: FakeObscuraServer!
    private var phone: FakeDevice!
    private var bob: FakeDevice!
    private var client: ObscuraClient!

    override func setUp() async throws {
        server = FakeObscuraServer()
        phone = try await server.register(UUID().uuidString.lowercased())
        bob = try await server.register(UUID().uuidString.lowercased())
        client = try await authenticatedClient(phone, username: "alice")
    }

    override func tearDown() async throws {
        try await client.logout()
        server.close()
    }

    private func receive(_ message: Obscura_Client_V1_ClientMessage, from sender: FakeDevice) async throws -> Int {
        try await send(message, from: sender, to: phone.userId)
        return await deliver(phone, to: client)
    }

    // MARK: - Guards

    func testSignedOutOperationsThrowNotAuthenticated() async throws {
        let client = try makeClient()

        await assertThrows(.notAuthenticated) { try await client.connect() }
        await assertThrows(.notAuthenticated) { _ = try await client.friendCode() }
        await assertThrows(.notAuthenticated) { try await client.sendTyping(to: ["x"], contextId: "c", state: .started) }
        await assertThrows(.notAuthenticated) {
            _ = try await client.send(to: ["x"], modelKey: "m", entryId: "e", sentAt: 1, payload: Data())
        }
        await assertThrows(.notAuthenticated) { try await client.addFriendByCode(FriendCode.encode(userId: "u", username: "n")) }
        await assertThrows(.notAuthenticated) { try await client.approveLink("code") }
        await assertThrows(.notAuthenticated) { _ = try await client.devices() }
        await assertThrows(.notAuthenticated) { try await client.unlinkDevice("d") }
    }

    func testABlankTypingContextIsRejected() async throws {
        await assertThrows(.invalidArgument("blank contextId")) {
            try await client.sendTyping(to: ["x"], contextId: " \n", state: .started)
        }
    }

    func testProvisioningOrLinkingAnExistingLocalDeviceRequiresAnExplicitWipe() async throws {
        let error = ObscuraError.invalidArgument("local device exists; wipeDevice before provisioning")
        await assertThrows(error) { try await self.client.register("new-account", "password") }
        await assertThrows(error) { _ = try await self.client.beginLink("new-account", "password", deviceName: "d") }
        XCTAssertTrue(try client.signalStore.hasIdentity())
        let deviceId = try await client.directory.localDeviceId()
        XCTAssertEqual(deviceId, phone.deviceId)
    }

    func testFriendCodeEncodesThisUser() async throws {
        let decoded = try FriendCode.decode(await client.friendCode())
        XCTAssertEqual(decoded.userId, phone.userId)
        XCTAssertEqual(decoded.username, "alice")
    }

    func testAnInvalidFriendCodeIsReportedAsSuch() async throws {
        await assertThrows(.invalidFriendCode) { try await self.client.addFriendByCode("garbage!") }
    }

    func testTheProvisionedDeviceIsPrimary() async throws {
        let isPrimary = try await client.isPrimary
        XCTAssertTrue(isPrimary)
    }

    // MARK: - Receive classification

    func testANewAppEntryIsInboxedAndWakesWithItsModelKeyButARedeliveryDoesNot() async throws {
        let wakes = Task {
            var values: [String] = []
            for await value in client.messageReceived { values.append(value) }
            return values
        }
        try await send(clientMessage {
            $0.appEntry.model = "story"
            $0.appEntry.id = "s1"
            $0.appEntry.timestamp = UInt64.max
            $0.appEntry.data = Data([1, 2, 3])
        }, from: bob, to: phone.userId)
        let envelope = try XCTUnwrap(phone.envelopes().first)

        await client.receive(envelope) { _ in }
        await client.receive(envelope) { _ in }

        let rows = try await client.inbox.peek(limit: 10)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].senderDeviceId, bob.deviceId)
        XCTAssertEqual(rows[0].payload, Data([1, 2, 3]))
        XCTAssertLessThanOrEqual(rows[0].sentAt, UInt64(Date().timeIntervalSince1970 * 1000) + 60_000)
        wakes.cancel()
        let woken = await wakes.value
        XCTAssertEqual(woken, ["story"])
    }

    func testAnUnknownArmIsAckedAndIgnoredWithoutAnInboxRow() async throws {
        // Field 4, the removed device link approval arm, as an empty message.
        let unknown = try Obscura_Client_V1_ClientMessage(serializedBytes: Data([0x22, 0x00]))

        let acks = try await receive(unknown, from: bob)

        XCTAssertEqual(acks, 1)
        let rows = try await client.inbox.peek(limit: 10)
        XCTAssertTrue(rows.isEmpty)
    }

    func testAFriendRequestFromAStrangerIsPendingAndAnAcceptedFriendsGetsAnAcceptReplyAndChangesNothing() async throws {
        _ = try await receive(clientMessage { $0.friendRequest.username = "mallory" }, from: bob)
        let stranger = try await client.friends.friend(bob.userId)
        XCTAssertEqual(stranger?.status, .pendingReceived)
        XCTAssertEqual(stranger?.username, "mallory")

        try await client.friends.updateStatus(bob.userId, .accepted)
        let accepted = try await client.friends.friend(bob.userId)
        _ = try await receive(clientMessage { $0.friendRequest.username = "Mum" }, from: bob)

        let after = try await client.friends.friend(bob.userId)
        XCTAssertEqual(after, accepted)
        let reply = try await bob.receive()
        XCTAssertEqual(reply.map { WireCodec.messageKind($0.message.payload) }, ["FRIEND_ACCEPT"])
        let depth = try await client.inbox.depth()
        XCTAssertEqual(depth, 0, "friend traffic is kit-internal")
    }

    func testAnAcceptPromotesOnlyARequestThisUserSent() async throws {
        let asker = try await server.register(UUID().uuidString.lowercased())
        let stranger = try await server.register(UUID().uuidString.lowercased())
        try await client.friends.add(bob.userId, username: "bob", status: .pendingSent)
        try await client.friends.add(asker.userId, username: "carol", status: .pendingReceived)
        let accept = clientMessage { $0.friendAccept = Obscura_Client_V1_FriendAccept() }

        for sender in [bob!, asker, stranger] { _ = try await receive(accept, from: sender) }

        let invited = try await client.friends.friend(bob.userId)
        let pending = try await client.friends.friend(asker.userId)
        let unknown = try await client.friends.friend(stranger.userId)
        XCTAssertEqual(invited?.status, .accepted)
        XCTAssertEqual(pending?.status, .pendingReceived)
        XCTAssertNil(unknown)
    }

    func testTypingSignalsDriveTheTrackerAndNeverTheInbox() async throws {
        let carol = try await server.register(UUID().uuidString.lowercased())
        _ = try await receive(clientMessage {
            $0.typingSignal.contextID = "c"
            $0.typingSignal.state = .unspecified
        }, from: carol)
        _ = try await receive(clientMessage {
            $0.typingSignal.contextID = "c"
            $0.typingSignal.state = .started
        }, from: bob)

        var typers = client.observeTyping(contextId: "c").makeAsyncIterator()
        let current = await typers.next()
        XCTAssertEqual(current, [bob.userId])
        let depth = try await client.inbox.depth()
        XCTAssertEqual(depth, 0)

        try await client.logout()
        let afterLogout = await typers.next()
        XCTAssertEqual(afterLogout, [], "typing state is cleared on logout")
    }
}
