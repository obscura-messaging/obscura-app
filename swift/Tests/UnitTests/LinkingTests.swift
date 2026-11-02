import Foundation
import LibSignalClient
import XCTest
@testable import ObscuraKit

/// Login outcomes, account reset, and the link handshake on both sides.
final class LinkingTests: XCTestCase {
    private var server: FakeObscuraServer!
    private var phone: FakeDevice!
    private var phoneClient: ObscuraClient!

    override func setUp() async throws {
        server = FakeObscuraServer()
        phone = try await server.register(UUID().uuidString.lowercased())
        server.account("alice", userId: phone.userId)
        phoneClient = try await authenticatedClient(phone, username: "alice")
    }

    override func tearDown() async throws {
        try await phoneClient.logout()
        server.close()
    }

    private func freshClient(_ storage: MemorySessionStorage = MemorySessionStorage()) throws -> ObscuraClient {
        try makeClient(apiURL: FakeObscuraServer.baseURL, storage: storage)
    }

    // MARK: - Login

    func testLoginOutcomes() async throws {
        let existing = try makeClient(apiURL: FakeObscuraServer.baseURL, database: phone.db)
        let outcome = try await existing.login("alice", "password")
        XCTAssertEqual(outcome, .existingDevice)
        XCTAssertEqual(existing.authState, .authenticated)
        try await existing.logout()

        let fresh = try freshClient()
        let linkRequired = try await fresh.login("alice", "password")
        XCTAssertEqual(linkRequired, .linkRequired)
        let invalid = try await fresh.login("nobody", "password")
        XCTAssertEqual(invalid, .invalidCredentials)
        XCTAssertEqual(fresh.authState, .loggedOut)

        let carol = UUID().uuidString.lowercased()
        let other = try await server.register(carol)
        let foreign = try makeClient(apiURL: FakeObscuraServer.baseURL, database: other.db)
        let mismatch = try await foreign.login("alice", "password")
        XCTAssertEqual(mismatch, .deviceMismatch)
        XCTAssertEqual(foreign.authState, .loggedOut)
    }

    func testAResetAccountWipesOldDataAndProvisionsANewPrimary() async throws {
        let storage = MemorySessionStorage()
        let client = try makeClient(apiURL: FakeObscuraServer.baseURL, database: phone.db, storage: storage)
        _ = try await client.login("alice", "password")
        let oldIdentity = try client.signalStore.identityKeyPair(context: NullContext()).serialize()
        try await client.content.insertConversationItem(ConversationItem(
            id: "e", peerUserId: "u", kind: "message", authorUserId: "u", sentAt: 1,
            viewedAt: nil, content: "x", attachment: nil,
            caption: nil, captionMeta: nil, displayDuration: 0
        ))

        try await client.resetAccount("alice", "password")

        XCTAssertEqual(client.authState, .authenticated)
        XCTAssertNotNil(storage.session)
        let isPrimary = try await client.isPrimary
        XCTAssertTrue(isPrimary)
        let newIdentity = try client.signalStore.identityKeyPair(context: NullContext()).serialize()
        XCTAssertNotEqual(newIdentity, oldIdentity)
        let messages = try await client.getMessages()
        XCTAssertEqual(messages, [])
        try await client.logout()
    }

    // MARK: - Primary

    func testApprovalSealsTheAccountIdentityFriendListAndHistoryForTheCode() async throws {
        try await phoneClient.friends.add("bob-id", username: "bob", status: .accepted)
        try await phoneClient.friends.add("carol-id", username: "carol", status: .pendingSent)
        try await phoneClient.content.insertStoryItem(StoryItem(
            id: "s1", authorUserId: "alice-id", sentAt: 7, content: "hi",
            attachment: nil, captionMeta: nil
        ))
        try await phoneClient.content.insertConversationItem(ConversationItem(
            id: "p1", peerUserId: "bob-id", kind: "message", authorUserId: "bob-id", sentAt: 9,
            viewedAt: nil, content: "ü", attachment: nil,
            caption: nil, captionMeta: nil, displayDuration: 0
        ))
        try await phoneClient.content.upsertProfile(ProfileItem(
            userId: "alice-id", authorDeviceId: "phone", updatedAt: 11, displayName: "Alice", bio: "bio"
        ))
        let newDevice = PrivateKey.generate()
        let sessionId = try await openLinkSession()

        try await phoneClient.approveLink(LinkCrypto.encode(linkCodeFixture(sessionId: sessionId, publicKey: newDevice.publicKey)))

        let body = try XCTUnwrap(server.linkSession(sessionId)?.body)
        let contents = try ObscuraClient.open(body, privateKey: Data(newDevice.serialize()), userId: phone.userId)
        XCTAssertEqual(contents.identity.serialize(), try phone.store.identityKeyPair(context: NullContext()).serialize())
        XCTAssertEqual(contents.primaryDeviceId, phone.deviceId)
        XCTAssertEqual(contents.friendListVersion, 2)
        XCTAssertEqual(contents.friends.map(\.userId), ["bob-id", "carol-id"])
        XCTAssertEqual(contents.friends.map(\.status), [.accepted, .pendingSent])
        let history = try XCTUnwrap(contents.history)
        let snapshot = try Obscura_Client_V1_EntrySnapshot(serializedBytes: AttachmentCrypto.open(
            XCTUnwrap(server.attachment(history.attachmentID)), key: history.contentKey, nonce: history.nonce))
        XCTAssertEqual(snapshot.messages.map(\.id), ["p1"])
        XCTAssertEqual(snapshot.messages.map(\.content), ["ü"])
        XCTAssertEqual(snapshot.stories.map(\.id), ["s1"])
        XCTAssertEqual(snapshot.stories.map(\.content), ["hi"])
        XCTAssertEqual(snapshot.profiles.map(\.userID), ["alice-id"])
        XCTAssertEqual(snapshot.profiles.map(\.displayName), ["Alice"])
    }

    func testAnEmptyEntryStoreSendsNoHistory() async throws {
        let newDevice = PrivateKey.generate()
        let sessionId = try await openLinkSession()

        try await phoneClient.approveLink(LinkCrypto.encode(linkCodeFixture(sessionId: sessionId, publicKey: newDevice.publicKey)))

        let body = try XCTUnwrap(server.linkSession(sessionId)?.body)
        let contents = try ObscuraClient.open(body, privateKey: Data(newDevice.serialize()), userId: phone.userId)
        XCTAssertNil(contents.history)
        XCTAssertEqual(contents.friends.count, 0)
    }

    func testApprovingAnUnknownSessionFailsTheLinkAndAnUnreadableCodeIsAnInvalidArgument() async throws {
        await assertThrows(.linkFailed("link session expired or unknown")) {
            try await self.phoneClient.approveLink(LinkCrypto.encode(linkCodeFixture(sessionId: "missing")))
        }
        for code in ["", "not base64!", "AAAA", try LinkCrypto.encode(linkCodeFixture(sessionId: ""))] {
            await assertThrows(.invalidArgument("link code")) { try await self.phoneClient.approveLink(code) }
        }
    }

    // MARK: - New device

    func testAnEnvelopeThatDoesNotDecryptFailsTheLinkAndAMalformedOrForeignBundleIsAViolation() throws {
        let newDevice = PrivateKey.generate()
        var bundle = Obscura_Client_V1_LinkBundle()
        bundle.identityKeyPair = Data(IdentityKeyPair.generate().serialize())
        bundle.userID = "alice-id"
        bundle.primaryDeviceID = phone.deviceId
        let body = try LinkCrypto.seal(bundle.serializedData(), to: newDevice.publicKey).serializedData()
        XCTAssertNoThrow(try ObscuraClient.open(body, privateKey: Data(newDevice.serialize()), userId: "alice-id"))

        for (body, key, userId, code) in [
            (body, PrivateKey.generate(), "alice-id", "LINK_FAILED"),
            (Data([0xff, 0x01]), newDevice, "alice-id", "LINK_FAILED"),
            (body, newDevice, "mallory-id", "PROTOCOL_VIOLATION"),
            (try LinkCrypto.seal(Data([0xff, 0x01]), to: newDevice.publicKey).serializedData(), newDevice, "alice-id",
             "PROTOCOL_VIOLATION"),
        ] {
            XCTAssertThrowsError(try ObscuraClient.open(body, privateKey: Data(key.serialize()), userId: userId)) {
                XCTAssertEqual(($0 as? ObscuraError)?.code, code)
            }
        }
        var badStatus = bundle
        var record = Obscura_Client_V1_FriendRecord()
        record.userID = "x"
        badStatus.friends = [record]
        let unusable = try LinkCrypto.seal(badStatus.serializedData(), to: newDevice.publicKey).serializedData()
        XCTAssertThrowsError(try ObscuraClient.open(unusable, privateKey: Data(newDevice.serialize()), userId: "alice-id")) {
            XCTAssertEqual(($0 as? ObscuraError)?.code, "PROTOCOL_VIOLATION")
        }
    }

    func testBeginLinkEncodesTheSessionTheKeyAndTheName() async throws {
        let client = try freshClient()

        let request = try await client.beginLink("alice", "password", deviceName: "Alice's iPad")

        let code = try LinkCrypto.decode(request.code)
        XCTAssertEqual(code.sessionID, request.sessionId)
        XCTAssertEqual(code.deviceName, "Alice's iPad")
        XCTAssertEqual(code.ephemeralPublicKey, Data(try PrivateKey(request.privateKey).publicKey.serialize()))
        XCTAssertEqual(server.linkSession(request.sessionId)?.userId, phone.userId)
        XCTAssertEqual(client.authState, .loggedOut)
    }

    func testAFailedLinkStoresNothing() async throws {
        let storage = MemorySessionStorage()
        let client = try freshClient(storage)

        let garbage = try await client.beginLink("alice", "password", deviceName: "d")
        server.approve(garbage.sessionId, body: Data([1, 2, 3]))
        do {
            try await client.completeLink(garbage)
            XCTFail("an unreadable envelope must fail the link")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "LINK_FAILED")
        }

        var expired = try await client.beginLink("alice", "password", deviceName: "d")
        expired = LinkRequest(code: expired.code, sessionId: "unknown", expiresAt: expired.expiresAt, username: "alice",
                              userId: expired.userId, deviceName: "d", privateKey: expired.privateKey)
        await assertThrows(.linkFailed("link session expired or unknown")) { try await client.completeLink(expired) }

        let refused = try await client.beginLink("alice", "password", deviceName: "d")
        try await phoneClient.approveLink(refused.code)
        server.failDeviceCreation(status: 403)
        do {
            try await client.completeLink(refused)
            XCTFail("a refused device must fail the link")
        } catch {
            XCTAssertEqual(error as? ObscuraError, .http(status: 403, body: ""))
        }

        XCTAssertFalse(try client.signalStore.hasIdentity())
        let localDevice = try await client.directory.localDeviceId()
        XCTAssertNil(localDevice)
        let friends = try await client.getFriends()
        XCTAssertEqual(friends, [])
        XCTAssertNil(storage.session)
        XCTAssertEqual(client.authState, .loggedOut)
    }

    private func openLinkSession() async throws -> String {
        try await freshClient().beginLink("alice", "password", deviceName: "d").sessionId
    }
}
