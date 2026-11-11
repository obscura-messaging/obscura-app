import Foundation
import XCTest
@testable import ObscuraKit

final class ServerContractTests: ScenarioTestCase {
    func testLocalFriendRequestAndAcceptWritesRecoverAfterDecryptFailure() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await bob.client.logout() }
        try await bob.client.db.write {
            try $0.execute(sql: """
                CREATE TRIGGER contract_friend_fault BEFORE INSERT ON friends
                BEGIN SELECT RAISE(ABORT, 'contract friend request persistence fault'); END
                """)
        }
        try await bob.client.connect()
        try await alice.client.befriend(bob.userId, username: bob.username)
        _ = try await eventually("friend request decrypt reaches the local write fault") {
            bob.client.getDebugLog().contains { $0.contains("contract friend request persistence fault") } ? true : nil
        }
        await bob.client.disconnect()
        try await bob.client.db.write { try $0.execute(sql: "DROP TRIGGER contract_friend_fault") }
        try await bob.client.connect()
        try await bob.waitForFriend(alice, .pendingReceived)

        try await alice.client.db.write {
            try $0.execute(sql: """
                CREATE TRIGGER contract_accept_fault BEFORE UPDATE ON friends
                BEGIN SELECT RAISE(ABORT, 'contract friend accept persistence fault'); END
                """)
        }
        try await alice.client.connect()
        try await bob.client.acceptFriend(alice.userId)
        _ = try await eventually("friend accept decrypt reaches the local write fault") {
            alice.client.getDebugLog().contains { $0.contains("contract friend accept persistence fault") } ? true : nil
        }
        await alice.client.disconnect()
        try await alice.client.db.write { try $0.execute(sql: "DROP TRIGGER contract_accept_fault") }
        try await alice.client.connect()
        try await alice.waitForFriend(bob, .accepted)
        let report = try await alice.send("friend-recovery-barrier", to: [bob])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        _ = try await bob.waitForEntry("friend-recovery-barrier")
        XCTAssertFalse(alice.client.getDebugLog().contains { $0.contains("decrypt failed") })
        XCTAssertFalse(bob.client.getDebugLog().contains { $0.contains("decrypt failed") })
    }

    func testAnInboxFailureAfterDecryptIsRecoverableOnReconnectAndThenAcknowledged() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await bob.client.logout() }
        try await bob.client.db.write { db in
            try db.execute(sql: """
                CREATE TRIGGER contract_inbox_fault BEFORE INSERT ON conversation_entries
                WHEN NEW.id = CAST('recover-after-decrypt' AS BLOB)
                BEGIN SELECT RAISE(ABORT, 'contract inbox persistence fault'); END
                """)
        }
        try await bob.client.connect()
        let report = try await alice.send("recover-after-decrypt", to: [bob])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        _ = try await eventually("real encrypted message reaches the injected post-decrypt inbox failure") {
            bob.client.getDebugLog().contains { $0.contains("contract inbox persistence fault") } ? true : nil
        }
        let empty = try await bob.client.getMessages()
        XCTAssertEqual(empty, [])
        await bob.client.disconnect()
        try await bob.client.db.write { try $0.execute(sql: "DROP TRIGGER contract_inbox_fault") }

        try await bob.client.connect()
        let recovered = try await bob.waitForEntry("recover-after-decrypt")
        XCTAssertEqual(recovered.authorUserId, alice.userId)
        let recoveredRows = try await bob.client.getMessages()
        XCTAssertEqual(recoveredRows.filter { $0.id == "recover-after-decrypt" }.count, 1)
        // A later encrypted message is a barrier for the gateway's queued delivery and ACK path.
        _ = try await alice.send("after-recovery-barrier", to: [bob])
        _ = try await bob.waitForEntry("after-recovery-barrier")
        await bob.client.disconnect()
        try await bob.client.connect()
        _ = try await alice.send("after-ack-barrier", to: [bob])
        _ = try await bob.waitForEntry("after-ack-barrier")
        let rowsAfterAck = try await bob.client.getMessages()
        XCTAssertEqual(rowsAfterAck.filter { $0.id == "recover-after-decrypt" }.count, 1)
        XCTAssertFalse(bob.client.getDebugLog().contains { $0.contains("decrypt failed") },
                       "the persisted message must ACK and disappear from the server, not recur as a duplicate Signal message")
    }

    func testPreKeySyncRotatesOnScheduleRefillsALowSupplyAndOldSessionsStillDecrypt() async throws {
        let storage = MemorySessionStorage()
        let bob = try await TestUser.register(makeClient(storage: storage))
        let alice = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await bob.client.logout() }
        let original = try await bundle(for: bob, fetchedBy: alice)
        try await alice.client.messenger.establishSessions(userId: bob.userId, [original])
        var delayed = Obscura_Client_V1_ClientMessage()
        delayed.directMessage.id = "delayed-before-rotation"
        delayed.directMessage.peerUserID = bob.userId
        delayed.directMessage.content = "before rotation"
        let pending = try await alice.client.messenger.prepareSubmission(
            deviceId: bob.deviceId, clientMessage: delayed.serializedData())
        let full = Int(PreKeys.batchSize)
        let afterFetch = try await bob.client.api.fetchPreKeyCounts()
        XCTAssertEqual(afterFetch, OneTimePreKeyCounts(oneTime: full - 1, kyber: full - 1), "the fetch used up one one-time key of each kind")

        // Two days since the last sync: connecting rotates the signed and last-resort keys.
        let store = bob.client.signalStore
        var state = try XCTUnwrap(store.preKeyState())
        let longAgo = Int64(Date().timeIntervalSince1970 * 1000) - PreKeys.refreshIntervalMs - 1
        state.syncedAt = longAgo
        state.rotatedAt = longAgo
        try store.savePreKeyState(state)
        // The refill below follows this sync within seconds.
        await bob.client.setPreKeySyncTiming(checkIntervalMs: PreKeys.checkIntervalMs, spacingMs: 0)
        try await bob.client.connect()
        let originalSignedId = UInt32(original.signedPreKey.keyId)
        let activeSigned = try await eventually("rotated signed pre-key is active") {
            try store.preKeyState().flatMap { $0.activeSignedId != originalSignedId ? $0.activeSignedId : nil }
        }
        let rotated = try await bundle(for: bob, fetchedBy: alice)
        XCTAssertEqual(rotated.identityKey, original.identityKey)
        XCTAssertEqual(UInt32(rotated.signedPreKey.keyId), activeSigned)
        XCTAssertNotEqual(rotated.kyberPreKey.keyId, original.kyberPreKey.keyId)
        XCTAssertNotNil(try store.findSignedPreKey(originalSignedId), "kept for messages in flight")

        // Leave the server only 5 of each kind. The delayed message, built on the original keys, still
        // decrypts after rotation, and as a pre-key message it makes bob refill both kinds, refreshing
        // his token on the way.
        let low = try PreKeys.prepareRefill(store, counts: OneTimePreKeyCounts(oneTime: 0, kyber: 0),
                                            nowMs: Int64(Date().timeIntervalSince1970 * 1000)).upload()
        try await bob.client.api.uploadPreKeys(PreKeysUpload(
            signedPreKey: nil, lastResortKyberPreKey: nil,
            oneTimePreKeys: Array(low.oneTimePreKeys.prefix(5)), kyberPreKeys: Array(low.kyberPreKeys.prefix(5))))
        let lowCounts = try await bob.client.api.fetchPreKeyCounts()
        XCTAssertEqual(lowCounts, OneTimePreKeyCounts(oneTime: 5, kyber: 5))
        let before = try XCTUnwrap(storage.session?["refreshToken"])
        try await bob.client.expireAccessToken()
        let delayedResult = await alice.client.messenger.submit(userId: bob.userId, submissions: [pending]).submitted
        XCTAssertEqual(delayedResult.map(\.result.status), [.accepted])
        let oldEntry = try await bob.waitForEntry(delayed.directMessage.id)
        XCTAssertEqual(oldEntry.content, delayed.directMessage.content, "the original signed key survives rotation")
        _ = try await eventually("server-visible refill") {
            try await bob.client.api.fetchPreKeyCounts() == OneTimePreKeyCounts(oneTime: full, kyber: full) ? true : nil
        }
        try await assertRotatedSession(bob, storage: storage, previous: before)

        let carol = try await TestUser.register()
        addTeardownBlock { try await carol.client.logout() }
        let hadSession = try await carol.client.messenger.hasSession(bob.deviceId)
        XCTAssertFalse(hadSession)
        let report = try await carol.send("new-rotated-bootstrap", to: [bob])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        let entry = try await bob.waitForEntry("new-rotated-bootstrap")
        XCTAssertEqual(entry.authorUserId, carol.userId)
        await bob.client.disconnect()
    }

    func testDeletingTheFinalWarmPeerDeviceReturnsAUserLevelRejection() async throws {
        let alice = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout() }
        try await alice.client.connect()
        let missingUserId = UUID().uuidString.lowercased()
        try await alice.client.directory.add(userId: missingUserId, deviceIds: [UUID().uuidString.lowercased()])

        var message = Obscura_Client_V1_ClientMessage()
        message.directMessage.id = "after-final-device-deletion"
        message.directMessage.peerUserID = missingUserId
        message.directMessage.content = "x"
        let report = try await alice.client.send(message, to: [missingUserId])
        XCTAssertEqual(report.recipients.count, 1, "removed targets must not turn a rejected user into an empty report")
        XCTAssertEqual(report.recipients.first?.userId, missingUserId)
        XCTAssertNil(report.recipients.first?.deviceId)
        XCTAssertEqual(report.recipients.first?.status, .rejected)
        XCTAssertNotNil(report.recipients.first?.error)
        let listed = try await alice.client.directory.deviceIds(of: missingUserId)
        XCTAssertEqual(listed, [])
        await alice.client.disconnect()
    }

    func testExpiredAccessTokensRefreshBeforeAttachmentAndPushOperations() async throws {
        let storage = MemorySessionStorage()
        let alice = try await TestUser.register(makeClient(storage: storage))
        addTeardownBlock { try await alice.client.logout() }
        let data = Data("attachment with an expired access token".utf8)
        let initial = try XCTUnwrap(storage.session?["refreshToken"])
        try await alice.client.expireAccessToken()
        let upload = try await alice.client.uploadAttachment(data)
        try await assertRotatedSession(alice, storage: storage, previous: initial)

        let beforeDownload = try XCTUnwrap(storage.session?["refreshToken"])
        try await alice.client.expireAccessToken()
        let download = try await alice.client.downloadDecryptedAttachment(
            id: upload.id, contentKey: upload.contentKey, nonce: upload.nonce)
        XCTAssertEqual(download, data)
        try await assertRotatedSession(alice, storage: storage, previous: beforeDownload)

        let beforePush = try XCTUnwrap(storage.session?["refreshToken"])
        try await alice.client.expireAccessToken()
        try await alice.client.registerPushToken("contract-token-\(UUID().uuidString)")
        try await assertRotatedSession(alice, storage: storage, previous: beforePush)

        let beforeConcurrent = try XCTUnwrap(storage.session?["refreshToken"])
        try await alice.client.expireAccessToken()
        async let uploading = alice.client.uploadAttachment(data)
        async let registering = alice.client.registerPushToken("concurrent-token-\(UUID().uuidString)")
        _ = try await uploading
        try await registering
        try await assertRotatedSession(alice, storage: storage, previous: beforeConcurrent)
    }

    func testAnOversizedRealMessageBatchIsDefinitivelyRejected() async throws {
        let alice = try await TestUser.register()
        let bob = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await bob.client.logout() }
        try await alice.client.messenger.establishSessions(userId: bob.userId, [bundle(for: bob, fetchedBy: alice)])
        var message = Obscura_Client_V1_ClientMessage()
        message.directMessage.id = "oversized"
        message.directMessage.peerUserID = bob.userId
        message.directMessage.content = "x"
        let plaintext = try message.serializedData()
        var submissions: [Obscura_V1_SendMessageRequest.Submission] = []
        for _ in 0..<101 {
            submissions.append(try await alice.client.messenger.prepareSubmission(deviceId: bob.deviceId, clientMessage: plaintext))
        }
        let results = await alice.client.messenger.submit(userId: bob.userId, submissions: submissions).submitted.map(\.result)
        XCTAssertEqual(results.count, 101)
        XCTAssertTrue(results.allSatisfy { $0.status == .rejected }, "HTTP 413 is a definitive pre-processing rejection")
        XCTAssertTrue(results.allSatisfy { $0.error?.contains("413") == true })
        let barrier = try await alice.send("valid-after-oversized", to: [bob])
        XCTAssertEqual(barrier.recipients.map(\.status), [.accepted])
        try await bob.client.connect()
        _ = try await bob.waitForEntry("valid-after-oversized")
        let rows = try await bob.client.getMessages()
        XCTAssertEqual(rows.map(\.id), ["valid-after-oversized"], "no oversized submission may have been queued")
        await bob.client.disconnect()
    }

    func testListingOwnDevicesAndWarmSessionSendsDoNotConsumePreKeys() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice)
        await laptop.client.disconnect()
        let bob = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await laptop.client.logout(); try await bob.client.logout() }
        let full = Int(PreKeys.batchSize)
        _ = try await bundle(for: alice, fetchedBy: bob)
        for _ in 0..<3 {
            let ids = try await alice.client.devices().map(\.deviceId)
            XCTAssertEqual(Set(ids), [alice.deviceId, laptop.deviceId])
        }
        let aliceCounts = try await alice.client.api.fetchPreKeyCounts()
        XCTAssertEqual(aliceCounts, OneTimePreKeyCounts(oneTime: full - 1, kyber: full - 1), "listing devices consumes no pre-keys")
        let laptopCounts = try await laptop.client.api.fetchPreKeyCounts()
        XCTAssertEqual(laptopCounts, OneTimePreKeyCounts(oneTime: full - 1, kyber: full - 1),
                       "a whole-user bundle fetch consumes one of each kind on every account device")

        for i in 0..<3 {
            let report = try await alice.send("session-reuse-\(i)", to: [bob])
            XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        }
        let bobCounts = try await bob.client.api.fetchPreKeyCounts()
        XCTAssertEqual(bobCounts, OneTimePreKeyCounts(oneTime: full - 1, kyber: full - 1),
                       "one initial session fetch, not a destructive fetch on every send")
        try await bob.client.connect()
        for i in 0..<3 { _ = try await bob.waitForEntry("session-reuse-\(i)") }
        await bob.client.disconnect()
    }

    private func bundle(for target: TestUser, fetchedBy observer: TestUser) async throws -> PreKeyBundleResponse {
        let bundles = try await observer.client.api.fetchPreKeyBundles(target.userId)
        return try XCTUnwrap(bundles.first { $0.deviceId == target.deviceId })
    }

    private func assertRotatedSession(_ user: TestUser, storage: MemorySessionStorage, previous: String) async throws {
        let stored = try XCTUnwrap(storage.session)
        XCTAssertNotEqual(stored["refreshToken"], previous)
        XCTAssertEqual(stored["userId"], user.userId)
        XCTAssertEqual(stored["deviceId"], user.deviceId)
        let current = try await user.client.requireSession()
        XCTAssertEqual(current.stored, stored, "rotation must be persisted before the operation succeeds")
        do {
            _ = try await user.client.api.refreshSession(previous)
            XCTFail("a rotated refresh token must not be reusable")
        } catch ObscuraError.http(let status, _) {
            XCTAssertEqual(status, 401)
        }
    }
}

private extension ObscuraClient {
    func expireAccessToken() throws {
        var current = try requireSession()
        current.token = "expired.token.sig"
        current.expiresAt = 1
        session = current
        api.setToken(current.token)
    }
}
