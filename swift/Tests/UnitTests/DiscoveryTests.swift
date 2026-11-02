import Foundation
import XCTest
@testable import ObscuraKit

/// How the directory learns devices: the send response, which names every recipient user, and
/// authenticated receive. The server's device list only confirms the primary.
final class DiscoveryTests: XCTestCase {
    private var server: FakeObscuraServer!

    override func setUp() {
        server = FakeObscuraServer()
    }

    override func tearDown() {
        server.close()
    }

    private func user() -> String { UUID().uuidString.lowercased() }

    func testSendingNeverListsDevices() async throws {
        let own = try await server.register(user())
        let peer = try await server.register(user())
        let client = try await authenticatedClient(own)

        let report = try await client.send(clientMessage { $0.directMessage.id = "delivered" }, to: [peer.userId])

        XCTAssertEqual(report.recipients.map(\.status), [.accepted])
        XCTAssertEqual(report.selfSync, [])
        XCTAssertEqual(server.deviceListFetches(own.userId), 0)
        XCTAssertEqual(server.bundleFetches(own.userId), 0)
        try await client.logout()
    }

    func testConnectDoesNotListDevicesOrConsumePrekeys() async throws {
        let userId = user()
        let phone = try await server.register(userId)
        let laptop = try await server.register(userId)
        let client = try await authenticatedClient(laptop)

        do { try await client.connect(); XCTFail("fake gateway is unavailable") } catch {}

        let primary = try await client.directory.primaryDeviceId()
        XCTAssertEqual(primary, phone.deviceId)
        let isPrimary = try await client.isPrimary
        XCTAssertFalse(isPrimary)
        let ids = try await client.directory.deviceIds(of: userId)
        XCTAssertEqual(ids, [laptop.deviceId], "the directory learns devices from sends and receives only")
        XCTAssertEqual(server.deviceListFetches(userId), 0)
        XCTAssertEqual(server.bundleFetches(userId), 0)
        XCTAssertEqual(phone.remainingPreKeys, 100)
        XCTAssertEqual(laptop.remainingPreKeys, 100)
        try await client.logout()
    }

    func testDevicesListsTheAccount() async throws {
        let userId = user()
        let phone = try await server.register(userId)
        let client = try await authenticatedClient(phone)
        let laptop = try await server.register(userId)

        let devices = try await client.devices()

        XCTAssertEqual(devices, [
            DeviceInfo(deviceId: phone.deviceId, name: "test", isPrimary: true, isThisDevice: true),
            DeviceInfo(deviceId: laptop.deviceId, name: "test", isPrimary: false, isThisDevice: false),
        ])
        try await client.logout()
    }

    func testSelfSyncReachesAnOwnDeviceLinkedAfterSignInWithoutListingDevices() async throws {
        let userId = user()
        let phone = try await server.register(userId)
        let client = try await authenticatedClient(phone)
        let laptop = try await server.register(userId)

        let report = try await client.send(clientMessage { $0.directMessage.id = "sync" }, to: [])

        XCTAssertEqual(report.selfSync.map(\.deviceId), [laptop.deviceId])
        XCTAssertEqual(report.selfSync.map(\.status), [.accepted])
        XCTAssertEqual(server.deviceListFetches(userId), 0)
        let received = try await laptop.receive()
        XCTAssertEqual(received.map(\.message.directMessage.id), ["sync"])
        try await client.logout()
    }

    func testPeerDevicesAreLearnedAdditivelyFromAuthenticatedReceiveAndReuseTheIncomingSession() async throws {
        let peerUserId = user()
        let oldPeer = try await server.register(peerUserId)
        let newPeer = try await server.register(peerUserId)
        let own = try await server.register(user())
        let client = try await authenticatedClient(own)
        try await client.directory.add(userId: peerUserId, deviceIds: [oldPeer.deviceId])
        try await newPeer.directory.add(userId: own.userId, deviceIds: [own.deviceId])
        try await send(clientMessage { $0.directMessage.id = "incoming" }, from: newPeer, to: own.userId)

        await deliver(own, to: client)

        let known = try await client.directory.deviceIds(of: peerUserId)
        XCTAssertEqual(Set(known), [oldPeer.deviceId, newPeer.deviceId])
        let report = try await client.send(clientMessage { $0.directMessage.id = "reply" }, to: [peerUserId])
        XCTAssertEqual(report.recipients.map(\.status), [.accepted, .accepted])
        XCTAssertEqual(server.bundleFetches(peerUserId), 0)
        XCTAssertEqual(server.deviceBundleFetches(oldPeer.deviceId), 1, "a device that must be resent needs a session")
        XCTAssertEqual(server.deviceBundleFetches(newPeer.deviceId), 0)
        let reply = try await newPeer.receive()
        XCTAssertEqual(reply.first?.message.directMessage.id, "reply")
        try await client.logout()
    }
}
