import Foundation
import XCTest
@testable import ObscuraKit

final class ServerContractTests: XCTestCase {
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
                CREATE TRIGGER contract_inbox_fault BEFORE INSERT ON inbox_rows
                WHEN NEW.entry_id = CAST('recover-after-decrypt' AS BLOB)
                BEGIN SELECT RAISE(ABORT, 'contract inbox persistence fault'); END
                """)
        }
        try await bob.client.connect()
        let report = try await alice.send("recover-after-decrypt", to: [bob])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        _ = try await eventually("real encrypted message reaches the injected post-decrypt inbox failure") {
            bob.client.getDebugLog().contains { $0.contains("contract inbox persistence fault") } ? true : nil
        }
        let empty = try await bob.client.inbox.depth()
        XCTAssertEqual(empty, 0)
        await bob.client.disconnect()
        try await bob.client.db.write { try $0.execute(sql: "DROP TRIGGER contract_inbox_fault") }

        try await bob.client.connect()
        let recovered = try await bob.waitForEntry("recover-after-decrypt")
        XCTAssertEqual(recovered.senderDeviceId, alice.deviceId)
        let recoveredRows = try await bob.client.inbox.peek(limit: 100)
        XCTAssertEqual(recoveredRows.filter { $0.entryId == "recover-after-decrypt" }.count, 1)
        // A later encrypted message is a barrier for the gateway's queued delivery and ACK path.
        _ = try await alice.send("after-recovery-barrier", to: [bob])
        _ = try await bob.waitForEntry("after-recovery-barrier")
        try await bob.client.inbox.consume(recoveredRows.map(\.id))
        await bob.client.disconnect()
        try await bob.client.connect()
        _ = try await alice.send("after-ack-barrier", to: [bob])
        _ = try await bob.waitForEntry("after-ack-barrier")
        let rowsAfterAck = try await bob.client.inbox.peek(limit: 100)
        XCTAssertFalse(rowsAfterAck.contains { $0.entryId == "recover-after-decrypt" })
        XCTAssertFalse(bob.client.getDebugLog().contains { $0.contains("decrypt failed") },
                       "the persisted message must ACK and disappear from the server, not recur as a duplicate Signal message")
    }

    func testGatewayAutomaticallyRefillsRepeatedlyAndRotatedKeysDecryptNewAndDelayedMessages() async throws {
        let storage = MemorySessionStorage()
        let bob = try await TestUser.register(makeClient(storage: storage))
        let alice = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await bob.client.logout() }
        let original = try await bundle(for: bob, fetchedBy: alice)
        XCTAssertEqual(original.signedPreKey.keyId, 1)
        try await alice.client.messenger.establishSessions(userId: bob.userId, [original])
        var delayed = Obscura_Client_V1_ClientMessage()
        delayed.appEntry.model = "contract"
        delayed.appEntry.id = "delayed-original-signed-key"
        delayed.appEntry.data = Data("before rotation".utf8)
        let pending = try await alice.client.messenger.prepareSubmission(
            deviceId: bob.deviceId, clientMessage: delayed.serializedData())

        _ = try await exhaustPreKeys(of: bob, fetchedBy: alice)
        try await bob.client.connect()
        let first = try await eventually("gateway refill publishes signed key 2 and new OPKs; \(bob.username)") {
            let value = try await self.bundle(for: bob, fetchedBy: alice)
            return value.signedPreKey.keyId > original.signedPreKey.keyId && value.oneTimePreKey != nil ? value : nil
        }
        XCTAssertEqual(first.identityKey, original.identityKey)
        XCTAssertGreaterThan(try XCTUnwrap(first.oneTimePreKey).keyId, 100)

        // Only the access token is expired; the real server-issued refresh token remains valid.
        let before = try XCTUnwrap(storage.session?["refreshToken"])
        try await bob.client.expireAccessToken()
        let second = try await eventually("second automatic refill refreshes auth and publishes newer signed key; \(bob.username)") {
            let value = try await self.bundle(for: bob, fetchedBy: alice)
            return value.signedPreKey.keyId > first.signedPreKey.keyId
                && (value.oneTimePreKey?.keyId ?? 0) > 150 ? value : nil
        }
        XCTAssertEqual(second.identityKey, original.identityKey)
        XCTAssertGreaterThan(try XCTUnwrap(second.oneTimePreKey).keyId, 150)
        try await assertRotatedSession(bob, storage: storage, previous: before)

        let delayedResult = await alice.client.messenger.submit(userId: bob.userId, submissions: [pending]).submitted
        XCTAssertEqual(delayedResult.map(\.result.status), [.accepted])
        let oldEntry = try await bob.waitForEntry(delayed.appEntry.id)
        XCTAssertEqual(oldEntry.payload, delayed.appEntry.data, "private signed key 1 must survive both rotations")

        let carol = try await TestUser.register()
        addTeardownBlock { try await carol.client.logout() }
        let hadSession = try await carol.client.messenger.hasSession(bob.deviceId)
        XCTAssertFalse(hadSession)
        let report = try await carol.send("new-rotated-bootstrap", to: [bob])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        let entry = try await bob.waitForEntry("new-rotated-bootstrap")
        XCTAssertEqual(entry.senderDeviceId, carol.deviceId)
        await bob.client.disconnect()
    }

    func testDeletingTheFinalWarmPeerDeviceReturnsAUserLevelRejection() async throws {
        let alice = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout() }
        try await alice.client.connect()
        let missingUserId = UUID().uuidString.lowercased()
        try await alice.client.directory.add(userId: missingUserId, deviceIds: [UUID().uuidString.lowercased()])

        let report = try await alice.client.send(
            to: [missingUserId], modelKey: "contract", entryId: "after-final-device-deletion",
            sentAt: 1, payload: Data("x".utf8))
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
        message.appEntry.model = "contract"
        message.appEntry.id = "oversized"
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
        let rows = try await bob.client.inbox.peek(limit: 200)
        XCTAssertEqual(rows.map(\.entryId), ["valid-after-oversized"], "no oversized submission may have been queued")
        await bob.client.disconnect()
    }

    func testListingOwnDevicesAndWarmSessionSendsDoNotConsumePreKeys() async throws {
        let alice = try await TestUser.register()
        let laptop = try await TestUser.link(to: alice)
        await laptop.client.disconnect()
        let bob = try await TestUser.register()
        addTeardownBlock { try await alice.client.logout(); try await laptop.client.logout(); try await bob.client.logout() }
        _ = try await bundle(for: alice, fetchedBy: bob)
        for _ in 0..<3 {
            let ids = try await alice.client.devices().map(\.deviceId)
            XCTAssertEqual(Set(ids), [alice.deviceId, laptop.deviceId])
        }
        let ownRemaining = try await exhaustPreKeys(of: alice, fetchedBy: bob)
        XCTAssertEqual(ownRemaining, 99, "listing devices must not consume either device's OPKs")
        let laptopEmpty = try await bundle(for: laptop, fetchedBy: bob)
        XCTAssertNil(laptopEmpty.oneTimePreKey, "a whole-user bundle fetch consumes one OPK on every account device")

        for i in 0..<3 {
            let report = try await alice.send("session-reuse-\(i)", to: [bob])
            XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        }
        let remaining = try await exhaustPreKeys(of: bob, fetchedBy: alice)
        XCTAssertEqual(remaining, 99,
                       "one initial session fetch, not a destructive fetch on every send")
        try await bob.client.connect()
        for i in 0..<3 { _ = try await bob.waitForEntry("session-reuse-\(i)") }
        await bob.client.disconnect()
    }

    private func bundle(for target: TestUser, fetchedBy observer: TestUser) async throws -> PreKeyBundleResponse {
        let bundles = try await observer.client.api.fetchPreKeyBundles(target.userId)
        return try XCTUnwrap(bundles.first { $0.deviceId == target.deviceId })
    }

    private func exhaustPreKeys(of target: TestUser, fetchedBy observer: TestUser) async throws -> Int {
        var consumed = 0
        for _ in 0...100 {
            if try await bundle(for: target, fetchedBy: observer).oneTimePreKey == nil { return consumed }
            consumed += 1
        }
        XCTFail("server OPK inventory did not exhaust within its 100-key limit")
        return consumed
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
