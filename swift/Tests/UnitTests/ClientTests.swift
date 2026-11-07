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
            _ = try await client.sendMessage(peerUserId: "x", content: "hi")
        }
        await assertThrows(.notAuthenticated) {
            _ = try await client.postStory(content: "hi", mediaRef: nil, contentKey: nil, nonce: nil, mediaType: nil, captionMeta: nil)
        }
        await assertThrows(.notAuthenticated) {
            try await client.updateProfile(displayName: "A", bio: "B")
        }
        await assertThrows(.notAuthenticated) {
            _ = try await client.flushOutbox()
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
        await assertThrows(.invalidArgument("entryId must not be blank")) {
            try await client.markSeen(entryId: " \n")
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

    func testANewStoryIsStoredAndWakesWithItsModelKeyButARedeliveryDoesNot() async throws {
        let wakes = Task {
            var values: [String] = []
            for await value in client.messageReceived { values.append(value) }
            return values
        }
        try await send(clientMessage {
            $0.timestamp = UInt64.max
            $0.story.id = "s1"
            $0.story.content = "hello story"
        }, from: bob, to: phone.userId)
        let envelope = try XCTUnwrap(phone.envelopes().first)

        await client.receive(envelope) { _ in }
        await client.receive(envelope) { _ in }

        let stories = try await client.getStories()
        XCTAssertEqual(stories.count, 1)
        XCTAssertEqual(stories[0].id, "s1")
        XCTAssertEqual(stories[0].authorUserId, bob.userId)
        XCTAssertEqual(stories[0].content, "hello story")
        XCTAssertLessThanOrEqual(stories[0].sentAt, UInt64(Date().timeIntervalSince1970 * 1000) + 60_000)
        wakes.cancel()
        let woken = await wakes.value
        XCTAssertEqual(woken, ["story"])
    }

    func testSendMessageToNonFriendQueuesInOutboxAndFlushesWhenAccepted() async throws {
        do {
            _ = try await client.sendMessage(peerUserId: bob.userId, content: "queued")
            XCTFail("expected send to non-friend to fail")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "SEND_FAILED")
        }
        let stored = try await client.getMessages()
        XCTAssertEqual(stored.count, 1)
        XCTAssertEqual(stored[0].content, "queued")

        try await client.friends.add(bob.userId, username: "bob", status: .accepted)
        let flushed = try await client.flushOutbox()
        XCTAssertEqual(flushed, 1)
        let bobReceived = try await bob.receive()
        XCTAssertEqual(bobReceived.map(\.message.directMessage.content), ["queued"])
    }

    func testIncomingPixIsStoredAndMarkSeenRecordsViewedTimestamp() async throws {
        try await client.friends.add(bob.userId, username: "bob", status: .accepted)
        let key = Data(repeating: 1, count: 32)
        let nonce = Data(repeating: 2, count: 12)
        _ = try await receive(clientMessage {
            $0.timestamp = 5_000
            $0.pix.id = "pix_1"
            $0.pix.peerUserID = phone.userId
            $0.pix.attachment.id = "att_1"
            $0.pix.attachment.contentKey = key
            $0.pix.attachment.nonce = nonce
            $0.pix.attachment.mediaType = "photo"
            $0.pix.caption = "look"
            $0.pix.displayDurationSecs = 7
        }, from: bob)

        let messages = try await client.getMessages()
        let pix = try XCTUnwrap(messages.first { $0.id == "pix_1" })
        XCTAssertEqual(pix.kind, "pix")
        XCTAssertEqual(pix.attachment, MediaAttachment(id: "att_1", contentKey: key, nonce: nonce, mediaType: "photo"))
        XCTAssertEqual(pix.caption, "look")
        XCTAssertEqual(pix.displayDuration, 7)
        XCTAssertNil(pix.viewedAt)

        try await client.markSeen(entryId: "pix_1")
        let afterSeen = try await client.getMessages()
        XCTAssertNotNil(afterSeen.first { $0.id == "pix_1" }?.viewedAt)
    }

    func testAnUnknownArmIsAckedAndIgnoredWithoutRows() async throws {
        // Field 4, the removed device link approval arm, as an empty message.
        let unknown = try Obscura_Client_V1_ClientMessage(serializedBytes: Data([0x22, 0x00]))

        let acks = try await receive(unknown, from: bob)

        XCTAssertEqual(acks, 1)
        let rows = try await client.getMessages()
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
        let messages = try await client.getMessages()
        XCTAssertEqual(messages, [], "friend traffic is kit-internal")
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

    func testTypingSignalsDriveTheTrackerAndNeverContentStores() async throws {
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
        let messages = try await client.getMessages()
        XCTAssertEqual(messages, [])

        try await client.logout()
        let afterLogout = await typers.next()
        XCTAssertEqual(afterLogout, [], "typing state is cleared on logout")
    }

    func testSendMessageValidationRejectsBlankAndSelfPeer() async throws {
        await assertThrows(.invalidArgument("peerUserId must not be blank")) {
            _ = try await self.client.sendMessage(peerUserId: "  ", content: "hi")
        }
        await assertThrows(.invalidArgument("cannot message yourself")) {
            _ = try await self.client.sendMessage(peerUserId: self.phone.userId, content: "hi")
        }
    }

    func testSendPixValidationRejectsInvalidPeerAndAttachmentKeyMaterial() async throws {
        await assertThrows(.invalidArgument("peerUserId must not be blank")) {
            _ = try await self.client.sendPix(
                peerUserId: " ", mediaRef: "m", contentKey: "AQID", nonce: "BAUG",
                mediaType: "photo", caption: "", captionMeta: nil, displayDuration: 5
            )
        }
        for (mediaRef, key, nonce) in [
            (" ", "AQID", "BAUG"),
            ("m", "not-base64!", "BAUG"),
            ("m", "", "BAUG"),
            ("m", "AQID", "not-base64!"),
            ("m", "AQID", ""),
        ] {
            await assertThrows(.invalidArgument("invalid pix attachment reference or key material")) {
                _ = try await self.client.sendPix(
                    peerUserId: self.bob.userId, mediaRef: mediaRef, contentKey: key, nonce: nonce,
                    mediaType: "photo", caption: "", captionMeta: nil, displayDuration: 5
                )
            }
        }
        await assertThrows(.invalidArgument("cannot message yourself")) {
            _ = try await self.client.sendPix(
                peerUserId: self.phone.userId, mediaRef: "m", contentKey: "AQID", nonce: "BAUG",
                mediaType: "photo", caption: "", captionMeta: nil, displayDuration: 5
            )
        }
    }

    func testSendMessageAndSendPixQueueWhenUnacceptedAndDeliverWhenAccepted() async throws {
        do {
            _ = try await client.sendPix(
                peerUserId: bob.userId, mediaRef: "att_queued",
                contentKey: Data([1, 2, 3]).base64EncodedString(),
                nonce: Data([4, 5, 6]).base64EncodedString(),
                mediaType: "", caption: "queued cap", captionMeta: "{\"y\":0.3}", displayDuration: 6
            )
            XCTFail("expected sendPix to non-friend to fail")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "SEND_FAILED")
        }

        try await client.friends.add(bob.userId, username: "bob", status: .accepted)
        let flushed = try await client.flushOutbox()
        XCTAssertEqual(flushed, 1)

        let dmId = try await client.sendMessage(peerUserId: bob.userId, content: "direct hi")
        XCTAssertTrue(dmId.hasPrefix("dm_"))
        let pixId = try await client.sendPix(
            peerUserId: bob.userId, mediaRef: "att_direct",
            contentKey: Data([7, 8]).base64EncodedString(),
            nonce: Data([9, 10]).base64EncodedString(),
            mediaType: "video", caption: "", captionMeta: nil, displayDuration: -1
        )
        XCTAssertTrue(pixId.hasPrefix("pix_"))

        let bobGot = try await bob.receive()
        XCTAssertEqual(bobGot.count, 3)

        // markSeen on own message or non-existent message is a no-op.
        try await client.markSeen(entryId: dmId)
        try await client.markSeen(entryId: "does_not_exist")
    }

    func testPostStoryValidatesAttachmentKeyMaterial() async throws {
        await assertThrows(.invalidArgument("invalid story attachment key material")) {
            _ = try await self.client.postStory(
                content: "bad", mediaRef: "att_1", contentKey: nil, nonce: "BAUG", mediaType: nil, captionMeta: nil
            )
        }
        await assertThrows(.invalidArgument("invalid story attachment key material")) {
            _ = try await self.client.postStory(
                content: "bad", mediaRef: "att_1", contentKey: "AQID", nonce: "!!!", mediaType: nil, captionMeta: nil
            )
        }
    }

    func testPostStoryAndUpdateProfileSucceedWithNoFriendsAndStepProfileTimestampsMonotonically() async throws {
        let s1 = try await client.postStory(
            content: "solo story", mediaRef: nil, contentKey: nil, nonce: nil, mediaType: nil, captionMeta: nil
        )
        XCTAssertTrue(s1.hasPrefix("story_"))
        try await client.updateProfile(displayName: "Alice 1", bio: "Bio 1")

        let futureTs = ObscuraClient.nowMs() + 100_000
        try await client.content.upsertProfile(ProfileItem(
            userId: phone.userId, authorDeviceId: phone.deviceId, updatedAt: futureTs, displayName: "Future", bio: "B"
        ))
        try await client.updateProfile(displayName: "Alice 2", bio: "Bio 2")
        let profiles = try await client.getProfiles()
        XCTAssertEqual(profiles.first?.displayName, "Alice 2")
        XCTAssertEqual(profiles.first?.updatedAt, futureTs + 1)
    }

    func testUndeliveredStoryAndProfileFlushWhenReachableFriendIsAvailable() async throws {
        let ghostUserId = UUID().uuidString.lowercased()
        try await client.friends.add(ghostUserId, username: "ghost", status: .accepted)
        do {
            _ = try await client.postStory(
                content: "media story", mediaRef: "att_s",
                contentKey: Data([1, 2]).base64EncodedString(),
                nonce: Data([3, 4]).base64EncodedString(),
                mediaType: nil, captionMeta: "{\"y\":0.5}"
            )
            XCTFail("expected story send to ghost to fail")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "SEND_FAILED")
        }
        do {
            try await client.updateProfile(displayName: "Alice 3", bio: "Bio 3")
            XCTFail("expected profile send to ghost to fail")
        } catch {
            XCTAssertEqual((error as? ObscuraError)?.code, "SEND_FAILED")
        }

        try await client.friends.remove(ghostUserId)
        try await client.friends.add(bob.userId, username: "bob", status: .accepted)
        let flushed = try await client.flushOutbox()
        XCTAssertEqual(flushed, 2)
        let flushedAgain = try await client.flushOutbox()
        XCTAssertEqual(flushedAgain, 0)
        let bobReceived = try await bob.receive()
        XCTAssertEqual(bobReceived.count, 2)
    }

    func testUploadDownloadAndCacheAttachmentFromFile() async throws {
        let testDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".att-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: testDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: testDir) }

        let cacheDir = testDir.appendingPathComponent("cache", isDirectory: true)
        let customClient = try ObscuraClient(
            apiURL: FakeObscuraServer.baseURL, database: phone.db, deviceName: "test-device",
            sessionStorage: MemorySessionStorage(), logger: SilentLogger(), attachmentCacheDir: cacheDir
        )
        try await customClient.begin(Session(
            token: phone.deviceId, refreshToken: "rt",
            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
            userId: phone.userId, deviceId: phone.deviceId, username: "alice"
        ))

        let inputFile = testDir.appendingPathComponent("input.bin")
        let payload = Data("secret-attachment-bytes".utf8)
        try payload.write(to: inputFile)

        let uploaded = try await customClient.uploadAttachmentFile(filePath: inputFile.path)
        let decrypted = try await customClient.downloadDecryptedAttachment(
            id: uploaded.id, contentKey: uploaded.contentKey, nonce: uploaded.nonce
        )
        XCTAssertEqual(decrypted, payload)

        await assertThrows(.invalidArgument("invalid base64 key/nonce")) {
            _ = try await customClient.downloadAttachmentToCache(
                id: uploaded.id, contentKeyBase64: "!!!", nonceBase64: "!!!"
            )
        }

        let cachedPath = try await customClient.downloadAttachmentToCache(
            id: uploaded.id,
            contentKeyBase64: uploaded.contentKey.base64EncodedString(),
            nonceBase64: uploaded.nonce.base64EncodedString()
        )
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: cachedPath)), payload)

        let cachedHit = try await customClient.downloadAttachmentToCache(
            id: uploaded.id, contentKeyBase64: "", nonceBase64: ""
        )
        XCTAssertEqual(cachedHit, cachedPath)
        try await customClient.logout()

        let noCacheClient = try ObscuraClient(
            apiURL: FakeObscuraServer.baseURL, database: phone.db, deviceName: "test-device",
            sessionStorage: MemorySessionStorage(), logger: SilentLogger(), attachmentCacheDir: nil
        )
        await assertThrows(.storageFailed("attachment cache directory unavailable")) {
            _ = try await noCacheClient.downloadAttachmentToCache(id: "x", contentKeyBase64: "AQID", nonceBase64: "BAUG")
        }
    }

    func testSweepExpiredPurgesCachedAttachmentFilesAndRegistersPushToken() async throws {
        let testDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent(".sweep-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: testDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: testDir) }

        let cacheDir = testDir.appendingPathComponent("cache", isDirectory: true)
        let customClient = try ObscuraClient(
            apiURL: FakeObscuraServer.baseURL, database: phone.db, deviceName: "test-device",
            sessionStorage: MemorySessionStorage(), logger: SilentLogger(), attachmentCacheDir: cacheDir
        )
        try await customClient.begin(Session(
            token: phone.deviceId, refreshToken: "rt",
            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
            userId: phone.userId, deviceId: phone.deviceId, username: "alice"
        ))

        let uploaded = try await customClient.uploadAttachment(Data("cached-pix".utf8))
        _ = try await customClient.downloadAttachmentToCache(
            id: uploaded.id,
            contentKeyBase64: uploaded.contentKey.base64EncodedString(),
            nonceBase64: uploaded.nonce.base64EncodedString()
        )
        try await customClient.content.insertConversationItem(ConversationItem(
            id: "exp_pix", peerUserId: bob.userId, kind: "pix", authorUserId: bob.userId,
            sentAt: 100, viewedAt: 100, content: "",
            attachment: MediaAttachment(id: uploaded.id, contentKey: uploaded.contentKey, nonce: uploaded.nonce, mediaType: "photo"),
            caption: nil, captionMeta: nil, displayDuration: 5
        ))
        let touched = try await customClient.sweepExpired(now: 100 + ContentStore.expireAfterViewMs + 1)
        XCTAssertEqual(touched, ["pix"])
        XCTAssertNil(AttachmentCrypto.readCached(cacheDir: cacheDir, id: uploaded.id))

        try await customClient.registerPushToken("apns-token-xyz")
        XCTAssertEqual(server.registeredPushTokens(), ["apns-token-xyz"])
        try await customClient.logout()
    }

    func testAddAndAcceptFriendRejectSelfAndMissingRequest() async throws {
        await assertThrows(.invalidArgument("cannot befriend yourself")) {
            try await self.client.addFriendByCode(FriendCode.encode(userId: self.phone.userId, username: "alice"))
        }
        await assertThrows(.invalidArgument("no friend request from \(bob.userId)")) {
            try await self.client.acceptFriend(self.bob.userId)
        }
    }

    func testFriendRequestLifecycleResendsAutoAcceptsMutualAndPromotesPendingReceived() async throws {
        let bobCode = FriendCode.encode(userId: bob.userId, username: "bob")
        try await client.addFriendByCode(bobCode)
        var status = try await client.friends.friend(bob.userId)?.status
        XCTAssertEqual(status, .pendingSent)

        try await client.addFriendByCode(bobCode)
        let bobReceived = try await bob.receive()
        XCTAssertEqual(bobReceived.count, 2)

        _ = try await receive(clientMessage { $0.friendRequest.username = "bob" }, from: bob)
        status = try await client.friends.friend(bob.userId)?.status
        XCTAssertEqual(status, .accepted)

        try await client.addFriendByCode(bobCode)

        let carol = try await server.register(UUID().uuidString.lowercased())
        try await client.friends.add(carol.userId, username: "carol", status: .pendingReceived)
        try await client.addFriendByCode(FriendCode.encode(userId: carol.userId, username: "carol"))
        let carolStatus = try await client.friends.friend(carol.userId)?.status
        XCTAssertEqual(carolStatus, .accepted)
    }

    func testPeerTypingValidatesArgumentsAndComputesCanonicalConversationId() async throws {
        await assertThrows(.invalidArgument("peerUserId must not be blank")) {
            try await self.client.sendTyping(peerUserId: "  ", state: .started)
        }
        await assertThrows(.invalidArgument("peerUserId must not be blank")) {
            _ = try await self.client.observePeerTyping("  ")
        }
        XCTAssertEqual(ObscuraClient.typingConvId("a", "b"), "a_b")
        XCTAssertEqual(ObscuraClient.typingConvId("b", "a"), "a_b")
    }

    func testObservePeerTypingTracksIncomingStartedAndStoppedSignals() async throws {
        let stream = try await client.observePeerTyping(bob.userId)
        var iterator = stream.makeAsyncIterator()
        let initial = await iterator.next()
        XCTAssertEqual(initial, false)

        let convId = ObscuraClient.typingConvId(phone.userId, bob.userId)
        _ = try await receive(clientMessage {
            $0.typingSignal.contextID = convId
            $0.typingSignal.state = .started
        }, from: bob)
        let afterStart = await iterator.next()
        XCTAssertEqual(afterStart, true)

        _ = try await receive(clientMessage {
            $0.typingSignal.contextID = convId
            $0.typingSignal.state = .stopped
        }, from: bob)
        let afterStop = await iterator.next()
        XCTAssertEqual(afterStop, false)
    }

    func testSendPeerTypingRateLimitsStartedAndLogsDeliveryFailure() async throws {
        try await client.sendTyping(peerUserId: bob.userId, state: .started)
        try await client.sendTyping(peerUserId: bob.userId, state: .started)
        try await client.sendTyping(peerUserId: bob.userId, state: .stopped)
        let bobTyping = try await bob.receive()
        XCTAssertEqual(bobTyping.count, 2)

        let ghost = UUID().uuidString.lowercased()
        try await client.sendTyping(peerUserId: ghost, state: .started)
        XCTAssertTrue(client.getDebugLog().contains { $0.contains("typing signal to \(ghost) failed") })
    }

    func testReceiveDirectMessageHandlesSelfSyncAndDropsInvalidPeerOrBlankId() async throws {
        let laptop = try await server.register(phone.userId)

        try await send(clientMessage {
            $0.timestamp = 1_000
            $0.directMessage.id = "self_dm_1"
            $0.directMessage.peerUserID = bob.userId
            $0.directMessage.content = "from laptop"
        }, from: laptop, to: phone.userId)
        try await send(clientMessage {
            $0.directMessage.id = "self_dm_bad"
            $0.directMessage.peerUserID = phone.userId
            $0.directMessage.content = "invalid self peer"
        }, from: laptop, to: phone.userId)
        try await send(clientMessage {
            $0.directMessage.id = " "
            $0.directMessage.peerUserID = bob.userId
        }, from: bob, to: phone.userId)
        try await send(clientMessage {
            $0.directMessage.id = "wrong_peer"
            $0.directMessage.peerUserID = UUID().uuidString.lowercased()
        }, from: bob, to: phone.userId)
        _ = await deliver(phone, to: client)

        let msgs = try await client.getMessages()
        XCTAssertEqual(msgs.map(\.id), ["self_dm_1"])
        XCTAssertEqual(msgs.first?.peerUserId, bob.userId)
        XCTAssertEqual(msgs.first?.authorUserId, phone.userId)
    }

    func testReceiveSeenReceiptUpdatesAuthoredEntryOnceAndIgnoresBlankEntryId() async throws {
        let laptop = try await server.register(phone.userId)
        try await send(clientMessage {
            $0.timestamp = 1_000
            $0.directMessage.id = "self_dm_1"
            $0.directMessage.peerUserID = bob.userId
            $0.directMessage.content = "from laptop"
        }, from: laptop, to: phone.userId)
        _ = await deliver(phone, to: client)

        _ = try await receive(clientMessage {
            $0.timestamp = 2_000
            $0.seenReceipt.entryID = "self_dm_1"
            $0.seenReceipt.peerUserID = phone.userId
            $0.seenReceipt.viewedAt = 1_800
        }, from: bob)
        var msgs = try await client.getMessages()
        XCTAssertEqual(msgs.first?.viewedAt, 1_800)

        _ = try await receive(clientMessage {
            $0.seenReceipt.entryID = " "
            $0.seenReceipt.peerUserID = phone.userId
        }, from: bob)
        _ = try await receive(clientMessage {
            $0.timestamp = 3_000
            $0.seenReceipt.entryID = "self_dm_1"
            $0.seenReceipt.peerUserID = phone.userId
            $0.seenReceipt.viewedAt = 2_500
        }, from: bob)
        msgs = try await client.getMessages()
        XCTAssertEqual(msgs.first?.viewedAt, 1_800)
    }

    func testReceiveValidatesPixStoryAndProfilePayloads() async throws {
        _ = try await receive(clientMessage {
            $0.pix.id = "bad_pix"
            $0.pix.peerUserID = phone.userId
        }, from: bob)
        _ = try await receive(clientMessage {
            $0.story.id = " "
        }, from: bob)
        _ = try await receive(clientMessage {
            $0.timestamp = 4_000
            $0.story.id = "story_att"
            $0.story.content = "with media"
            $0.story.attachment.id = "att_st"
            $0.story.attachment.contentKey = Data([1])
            $0.story.attachment.nonce = Data([2])
            $0.story.attachment.mediaType = ""
            $0.story.captionMeta = "meta"
        }, from: bob)
        _ = try await receive(clientMessage {
            $0.timestamp = 5_000
            $0.profile.displayName = "Bob Name"
            $0.profile.bio = "Bob Bio"
        }, from: bob)

        let stories = try await client.getStories(now: 4_000)
        XCTAssertEqual(stories.map(\.id), ["story_att"])
        XCTAssertEqual(stories.first?.attachment?.mediaType, "photo")
        let profiles = try await client.getProfiles()
        XCTAssertEqual(profiles.first { $0.userId == bob.userId }?.displayName, "Bob Name")
    }

    func testReceiveTriggersPreKeyReplenishmentWhenLocalCountIsLow() async throws {
        try await client.db.write { db in
            try db.execute(sql: "DELETE FROM signal_prekeys WHERE key_id > 5")
        }
        _ = try await receive(clientMessage {
            $0.timestamp = 6_000
            $0.directMessage.id = "trigger_replenish"
            $0.directMessage.peerUserID = phone.userId
            $0.directMessage.content = "replenish"
        }, from: bob)
        for _ in 0..<30 {
            if server.preKeyUploadCount() > 0 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(server.preKeyUploadCount(), 1)
        XCTAssertGreaterThanOrEqual(try client.signalStore.preKeyCount(), 50)
    }
}
