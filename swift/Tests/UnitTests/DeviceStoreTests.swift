import Foundation
import GRDB
import XCTest
@testable import ObscuraKit

final class DeviceStoreTests: XCTestCase {
    private var db: DatabaseQueue!
    private var devices: DeviceStore!
    private var friends: FriendStore!

    override func setUp() async throws {
        db = try ObscuraDatabase.inMemory()
        devices = DeviceStore(db: db)
        friends = FriendStore(db: db)
    }

    func testDevicesAreListedPerUserAndCannotChangeOwner() async throws {
        try await devices.add(userId: "me", deviceIds: ["d1"])
        try await devices.add(userId: "peer", deviceIds: ["d2", "d2"])
        await assertThrows(.protocolViolation("device d1 belongs to me, not peer")) {
            try await self.devices.add(userId: "peer", deviceIds: ["d1"])
        }

        let mine = try await devices.deviceIds(of: "me")
        let theirs = try await devices.deviceIds(of: "peer")
        XCTAssertEqual(mine, ["d1"])
        XCTAssertEqual(theirs, ["d2"])
    }

    func testRemoveForgetsOnlyTheNamedDevices() async throws {
        try await devices.add(userId: "peer", deviceIds: ["a", "b"])

        try await devices.remove(userId: "peer", deviceIds: ["a", "unknown"])

        let left = try await devices.deviceIds(of: "peer")
        XCTAssertEqual(left, ["b"])
    }

    func testTheLocalDeviceAndItsPrimaryAreSingular() async throws {
        let none = try await devices.localDeviceId()
        let noPrimary = try await devices.isPrimary()
        XCTAssertNil(none)
        XCTAssertFalse(noPrimary)

        try await db.write { try DeviceStore.setLocalDevice("first", primaryDeviceId: "first", in: $0) }
        let primary = try await devices.isPrimary()
        XCTAssertTrue(primary)
        try await db.write { try DeviceStore.setLocalDevice("second", primaryDeviceId: "first", in: $0) }

        let local = try await devices.localDeviceId()
        let linked = try await devices.isPrimary()
        let primaryId = try await devices.primaryDeviceId()
        XCTAssertEqual(local, "second")
        XCTAssertEqual(primaryId, "first")
        XCTAssertFalse(linked)
    }

    func testRemovingAFriendForgetsTheirDevices() async throws {
        try await friends.add("peer", username: "alice", status: .accepted)
        try await devices.add(userId: "peer", deviceIds: ["dev-a"])
        try await devices.add(userId: "other", deviceIds: ["dev-b"])

        try await friends.remove("peer")

        let friend = try await friends.friend("peer")
        let peerDevices = try await devices.deviceIds(of: "peer")
        let otherDevices = try await devices.deviceIds(of: "other")
        XCTAssertNil(friend)
        XCTAssertEqual(peerDevices, [])
        XCTAssertEqual(otherDevices, ["dev-b"])
    }

    func testFriendTextWithEmbeddedNULRoundTripsAndDoesNotCollide() async throws {
        try await friends.add("victim\0junk", username: "Mum\0🙂", status: .pendingSent)
        try await friends.add("victim", username: "victim", status: .accepted)

        let all = try await friends.all()
        XCTAssertEqual(all.map(\.userId), ["victim", "victim\0junk"])
        XCTAssertEqual(all.map(\.username), ["victim", "Mum\0🙂"])
        let removed = try await friends.removePendingSent("victim\0junk")
        XCTAssertTrue(removed)
        let left = try await friends.all()
        XCTAssertEqual(left.map(\.status), [.accepted])
    }

    func testEveryFriendChangeBumpsTheVersionAndANoOpDoesNot() async throws {
        func version() async throws -> UInt64 { try await db.read { try FriendStore.version(in: $0) } }
        let initial = try await version()
        XCTAssertEqual(initial, 0)

        try await friends.add("a", username: "a", status: .pendingSent)
        try await friends.updateStatus("a", .accepted)
        let removedAccepted = try await friends.removePendingSent("a")
        try await friends.add("b", username: "b", status: .pendingSent)
        let removedPending = try await friends.removePendingSent("b")
        try await friends.remove("a")
        try await friends.remove("missing")

        XCTAssertFalse(removedAccepted)
        XCTAssertTrue(removedPending)
        let final = try await version()
        XCTAssertEqual(final, 5)
    }

    func testAReplacedListTakesTheGivenVersionAndContents() async throws {
        try await friends.add("old", username: "old", status: .accepted)

        try await db.write {
            try FriendStore.replace([("new", "new", .pendingReceived)], version: 42, in: $0)
        }

        let all = try await friends.all()
        XCTAssertEqual(all.map(\.userId), ["new"])
        XCTAssertEqual(all.map(\.status), [.pendingReceived])
        let sync = try await friends.listSync()
        XCTAssertEqual(sync.version, 42)
        XCTAssertEqual(sync.friends.map(\.userID), ["new"])
        XCTAssertEqual(sync.friends.map(\.status), [.pendingReceived])
    }
}
