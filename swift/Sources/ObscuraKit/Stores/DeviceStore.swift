import Foundation
import GRDB

/// This device's identity plus every device the client can address, its own included.
actor DeviceStore {
    private let db: DatabaseQueue

    init(db: DatabaseQueue) {
        self.db = db
    }

    func localDeviceId() async throws -> String? {
        try await db.read { db in try String.fetchOne(db, sql: "SELECT device_id FROM device_identity WHERE id = 1") }
    }

    /// The account's primary device as last confirmed by the server; nil before provisioning.
    func primaryDeviceId() async throws -> String? {
        try await db.read { db in try Self.primaryDeviceId(in: db) }
    }

    static func primaryDeviceId(in db: Database) throws -> String? {
        try String.fetchOne(db, sql: "SELECT primary_device_id FROM device_identity WHERE id = 1")
    }

    func isPrimary() async throws -> Bool {
        try await db.read { db in try Self.isPrimary(in: db) }
    }

    static func isPrimary(in db: Database) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT device_id = primary_device_id FROM device_identity WHERE id = 1") ?? false
    }

    static func setLocalDevice(_ deviceId: String, primaryDeviceId: String, in db: Database) throws {
        try db.execute(sql: "INSERT OR REPLACE INTO device_identity (id, device_id, primary_device_id) VALUES (1, ?, ?)",
                       arguments: [deviceId, primaryDeviceId])
    }

    func deviceIds(of userId: String) async throws -> [String] {
        try await db.read { db in
            try String.fetchAll(db, sql: "SELECT device_id FROM devices WHERE user_id = ? ORDER BY device_id", arguments: [userId])
        }
    }

    func add(userId: String, deviceIds: [String]) async throws {
        try await db.write { db in
            for deviceId in deviceIds { try Self.add(userId: userId, deviceId: deviceId, in: db) }
        }
    }

    static func add(userId: String, deviceId: String, in db: Database) throws {
        if let existing = try String.fetchOne(db, sql: "SELECT user_id FROM devices WHERE device_id = ?", arguments: [deviceId]),
           existing != userId {
            throw ObscuraError.protocolViolation("device \(deviceId) belongs to \(existing), not \(userId)")
        }
        try db.execute(sql: "INSERT OR REPLACE INTO devices (user_id, device_id) VALUES (?, ?)", arguments: [userId, deviceId])
    }

    func remove(userId: String, deviceIds: [String]) async throws {
        try await db.write { db in
            for deviceId in deviceIds {
                try db.execute(sql: "DELETE FROM devices WHERE user_id = ? AND device_id = ?", arguments: [userId, deviceId])
                if db.changesCount > 0 {
                    try db.execute(sql: "DELETE FROM signal_sessions WHERE address = ?", arguments: ["\(deviceId).\(Messenger.deviceSlot)"])
                }
            }
        }
    }
}
