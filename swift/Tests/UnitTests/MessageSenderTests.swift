import Foundation
import XCTest
@testable import ObscuraKit

/// The send path against real Signal peers on an in-process server with complete delivery. Every
/// bundle fetch consumes a one-time prekey, so the fetch counts here are the prekey cost.
final class MessageSenderTests: XCTestCase {
    private var server: FakeObscuraServer!
    private var alice: FakeDevice!
    private var bob: FakeDevice!

    override func setUp() async throws {
        server = FakeObscuraServer()
        alice = try await server.register(user())
        bob = try await server.register(user())
    }

    override func tearDown() {
        server.close()
    }

    private func user() -> String { UUID().uuidString.lowercased() }

    private func entry(_ id: String) -> Data {
        try! clientMessage {
            $0.appEntry.model = "m"
            $0.appEntry.id = id
        }.serializedData()
    }

    private func send(_ from: FakeDevice, to: FakeDevice, _ id: String) async -> [SubmissionResult] {
        await from.sender.send(to: to.userId, entry(id))
    }

    private func accepted(_ device: FakeDevice) -> SubmissionResult {
        SubmissionResult(userId: device.userId, deviceId: device.deviceId, status: .accepted)
    }

    private func ids(_ received: [Received]) -> [String] { received.map(\.message.appEntry.id) }

    private func byDevice(_ results: [SubmissionResult]) -> [SubmissionResult] {
        results.sorted { ($0.deviceId ?? "") < ($1.deviceId ?? "") }
    }

    func testFirstContactFetchesTheUserOnceAndLaterSendsReuseTheSession() async throws {
        for i in 0..<3 {
            let results = await send(alice, to: bob, "e\(i)")
            XCTAssertEqual(results, [accepted(bob)])
        }

        let received = try await bob.receive()
        XCTAssertEqual(ids(received), ["e0", "e1", "e2"])
        // Unacknowledged sessions keep sending prekey messages, all from the one session.
        XCTAssertEqual(Set(received.compactMap(\.baseKey).map { $0.serialize() }).count, 1)
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
        XCTAssertEqual(bob.remainingPreKeys, 99)
    }

    func testAReplyUsesTheSessionTheIncomingMessageBuiltAndFetchesNothing() async throws {
        _ = await send(alice, to: bob, "hello")
        _ = try await bob.receive()

        let reply = await send(bob, to: alice, "reply")
        XCTAssertEqual(reply, [accepted(alice)])
        XCTAssertEqual(server.bundleFetches(alice.userId), 0)
        XCTAssertEqual(server.deviceBundleFetches(alice.deviceId), 0)
        let aliceGot = try await alice.receive().map(\.type)
        XCTAssertEqual(aliceGot, [.encryptedMessage])

        _ = await send(alice, to: bob, "after-reply")
        let bobGot = try await bob.receive().map(\.type)
        XCTAssertEqual(bobGot, [.encryptedMessage])
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
    }

    func testADeviceMismatchAddsTheMissingDeviceFetchesOnlyItsBundleAndRetriesWithAFreshKey() async throws {
        _ = await send(alice, to: bob, "first")
        let firstKey = try await bob.receive().first?.baseKey
        let bobTablet = try await server.register(bob.userId)
        let requestsBefore = server.messageRequests()

        let results = await send(alice, to: bob, "second")

        XCTAssertEqual(Set(results.map(\.deviceId)), [bob.deviceId, bobTablet.deviceId])
        XCTAssertTrue(results.allSatisfy { $0.status == .accepted })
        let secondKey = try await bob.receive().first?.baseKey
        XCTAssertEqual(secondKey, firstKey, "the existing session is kept")
        let tabletGot = try await bobTablet.receive()
        XCTAssertEqual(ids(tabletGot), ["second"])
        XCTAssertEqual(tabletGot.map(\.type), [.prekeyMessage])
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
        XCTAssertEqual(server.deviceBundleFetches(bobTablet.deviceId), 1)
        XCTAssertEqual(bob.remainingPreKeys, 99, "the mismatch costs only the new device a prekey")
        XCTAssertEqual(server.messageRequests() - requestsBefore, 2)
        XCTAssertEqual(Set(server.idempotencyKeys).count, server.idempotencyKeys.count, "every submission has a new key")
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(Set(listed), [bob.deviceId, bobTablet.deviceId])
    }

    func testADeviceTheServerNoLongerHasIsDroppedFromTheDirectoryAndTheReport() async throws {
        let bobTablet = try await server.register(bob.userId)
        _ = await send(alice, to: bob, "first")
        server.remove(bobTablet)

        let second = await send(alice, to: bob, "second")

        XCTAssertEqual(second, [accepted(bob)])
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listed, [bob.deviceId])
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
    }

    func testMismatchesStopAfterThreeRoundsWithTheRemainingResultsRejected() async throws {
        _ = await send(alice, to: bob, "warm")
        let phantom = UUID().uuidString.lowercased()
        FakeServerProtocol.messageResponse.withLock { respond in
            respond = { _ in
                var response = Obscura_V1_SendMessageResponse()
                var mismatch = Obscura_V1_SendMessageResponse.DeviceMismatch()
                mismatch.userID = uuidBytes(self.bob.userId)!
                mismatch.missingDeviceIds = [uuidBytes(phantom)!]
                response.deviceMismatches = [mismatch]
                return (200, try! response.serializedData())
            }
        }

        let results = await send(alice, to: bob, "never")

        XCTAssertEqual(results.map(\.deviceId), [bob.deviceId])
        XCTAssertEqual(results.map(\.status), [.rejected])
        XCTAssertEqual(results.first?.error, "devices not covered: \(phantom)")
        XCTAssertEqual(server.deviceBundleFetches(phantom), 2, "each retry fetches the missing device, which does not exist")
    }

    func testSelfSyncNeverTargetsThisDeviceAndASingleDeviceOnlyAsksTheServer() async throws {
        let results = await send(alice, to: alice, "note")
        XCTAssertEqual(results, [])
        XCTAssertEqual(server.bundleFetches(alice.userId), 0)
        XCTAssertEqual(server.messageRequests(), 1, "a request naming the user and targeting nothing")
    }

    func testSelfSyncDiscoversOwnDevicesItHasNeverSeenThroughTheMismatch() async throws {
        let phone = try await server.register(alice.userId)
        let tablet = try await server.register(alice.userId)

        let results = await send(alice, to: alice, "note")

        XCTAssertEqual(byDevice(results), byDevice([accepted(phone), accepted(tablet)]))
        let phoneGot = try await phone.receive()
        let tabletGot = try await tablet.receive()
        XCTAssertEqual(ids(phoneGot), ["note"])
        XCTAssertEqual(ids(tabletGot), ["note"])
        let echoed = try await alice.receive().count
        XCTAssertEqual(echoed, 0)
        XCTAssertEqual(server.bundleFetches(alice.userId), 0, "own devices are never fetched whole")
    }

    func testConcurrentFirstSendsShareOneFetch() async throws {
        let (alice, bob) = (alice!, bob!)
        let results = await withTaskGroup(of: [SubmissionResult].self) { group in
            for i in 1...5 { group.addTask { await alice.sender.send(to: bob.userId, self.entry("c\(i)")) } }
            return await group.reduce(into: []) { $0.append($1) }
        }

        XCTAssertTrue(results.allSatisfy { $0 == [accepted(bob)] })
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
        let delivered = try await bob.receive().count
        XCTAssertEqual(delivered, 5)
    }

    func testAUserWithNoDevicesIsRejected() async throws {
        let ghost = user()
        let results = await alice.sender.send(to: ghost, entry("lost"))

        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.userId, ghost)
        XCTAssertNil(results.first?.deviceId)
        XCTAssertEqual(results.first?.status, .rejected)
    }

    func testDeletingTheFinalWarmDeviceReturnsAUserLevelRejection() async throws {
        let warm = await send(alice, to: bob, "warm")
        XCTAssertEqual(warm, [accepted(bob)])
        server.remove(bob)
        let results = await send(alice, to: bob, "gone")
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.userId, bob.userId)
        XCTAssertNil(results.first?.deviceId)
        XCTAssertEqual(results.first?.status, .rejected)
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listed, [])
    }

    func testAFetchWithAnUnverifiableBundleRejectsTheUserAndStoresNothing() async throws {
        _ = try await server.register(bob.userId, corruptBundle: true)

        for _ in 0..<2 {
            let results = await send(alice, to: bob, "one")
            XCTAssertEqual(results.map(\.status), [.rejected])
            XCTAssertNil(results.first?.deviceId)
        }
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listed, [])
        let session = try await alice.messenger.hasSession(bob.deviceId)
        XCTAssertFalse(session)
    }

    func testAFetchWhoseBundlesCarryDifferentIdentitiesRejectsTheUserAndStoresNothing() async throws {
        let rogue = try await server.register(bob.userId, rogueIdentity: true)

        let results = await send(alice, to: bob, "one")

        XCTAssertEqual(results.map(\.status), [.rejected])
        XCTAssertTrue(results.first?.error?.contains("identity") == true)
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listed, [])
        let bobSession = try await alice.messenger.hasSession(bob.deviceId)
        let rogueSession = try await alice.messenger.hasSession(rogue.deviceId)
        XCTAssertFalse(bobSession)
        XCTAssertFalse(rogueSession)
    }

    func testAResetPeerIsReachedInTheSameSendAsAnIdentityChangeForTheWholeAccount() async throws {
        _ = await send(alice, to: bob, "before")
        _ = try await bob.receive()
        let reset = try await server.reset(bob.userId)

        let after = await send(alice, to: bob, "after")

        XCTAssertEqual(after, [accepted(reset)])
        let resetGot = try await reset.receive()
        XCTAssertEqual(ids(resetGot), ["after"])
        XCTAssertEqual(alice.logger.snapshot().filter { $0.hasPrefix("identity changed") },
                       ["identity changed for \(bob.userId)"])
        let listed = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listed, [reset.deviceId])
    }

    func testAResetPeersIncomingPrekeyMessageReplacesTheIdentityAndDropsTheOldDevicesSessions() async throws {
        _ = await send(alice, to: bob, "before")
        _ = try await bob.receive()
        let reset = try await server.reset(bob.userId)

        _ = await send(reset, to: alice, "from-new-identity")
        let aliceGot = try await alice.receive()
        XCTAssertEqual(ids(aliceGot), ["from-new-identity"])
        XCTAssertEqual(alice.logger.snapshot().filter { $0.hasPrefix("identity changed") },
                       ["identity changed for \(bob.userId)"])
        let oldSession = try await alice.messenger.hasSession(bob.deviceId)
        XCTAssertFalse(oldSession)
        let listedAfterReceive = try await alice.directory.deviceIds(of: bob.userId)
        XCTAssertEqual(listedAfterReceive, [reset.deviceId])

        let reply = await send(alice, to: bob, "to-new-identity")
        XCTAssertEqual(reply, [accepted(reset)])
        let resetGot = try await reset.receive()
        XCTAssertEqual(ids(resetGot), ["to-new-identity"])
        XCTAssertEqual(resetGot.map(\.type), [.encryptedMessage])
        XCTAssertEqual(server.bundleFetches(bob.userId), 1)
        XCTAssertEqual(server.deviceBundleFetches(bob.deviceId), 0)
    }

    func testALinkedDeviceSharesTheAccountIdentityWithoutAnIdentityChange() async throws {
        _ = await send(alice, to: bob, "before")
        let tablet = try await server.register(bob.userId)

        _ = await send(alice, to: bob, "after")

        let tabletGot = try await tablet.receive()
        XCTAssertEqual(ids(tabletGot), ["after"])
        XCTAssertTrue(alice.logger.snapshot().filter { $0.hasPrefix("identity changed") }.isEmpty)
    }

    func testAMultiUserSendBatchesRecipientsIntoOneRequestAndRetriesOnlyAMismatchedUser() async throws {
        let carol = try await server.register(user())
        _ = await send(alice, to: bob, "warm-bob")
        _ = await send(alice, to: carol, "warm-carol")
        _ = try await bob.receive()
        _ = try await carol.receive()
        let carolTablet = try await server.register(carol.userId)
        let before = server.messageRequests()

        let results = await alice.sender.send(to: [bob.userId, carol.userId], entry("batched"))

        XCTAssertEqual(byDevice(results), byDevice([accepted(bob), accepted(carol), accepted(carolTablet)]))
        XCTAssertEqual(server.messageRequests() - before, 2, "round 1 settles bob and discovers carolTablet; round 2 retries carol only")
        let bobGot = try await bob.receive()
        let carolGot = try await carol.receive()
        let tabletGot = try await carolTablet.receive()
        XCTAssertEqual(ids(bobGot), ["batched"])
        XCTAssertEqual(ids(carolGot), ["batched"])
        XCTAssertEqual(ids(tabletGot), ["batched"])
    }
}
