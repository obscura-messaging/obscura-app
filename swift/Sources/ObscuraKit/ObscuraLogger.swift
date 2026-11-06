import Foundation

public protocol ObscuraLogger: Sendable {
    func log(_ message: String)
    func decryptFailed(sourceUserId: String, reason: String)
    func ackFailed(envelopeId: String, reason: String)
    func tokenRefreshFailed(attempt: Int, reason: String)
    func preKeyReplenishFailed(reason: String)
    func identityChanged(userId: String)
    func sessionEstablishFailed(userId: String, reason: String)
    func databaseError(store: String, operation: String, reason: String)
}

/// Forwards to the host logger and keeps the newest lines for `getDebugLog()`.
final class RecordingLogger: ObscuraLogger {
    private let host: ObscuraLogger
    private let lines = Locked<[String]>([])
    private let capacity = 200

    init(_ host: ObscuraLogger) {
        self.host = host
    }

    func snapshot() -> [String] {
        lines.withLock { $0 }
    }

    private func record(_ line: String) {
        lines.withLock { lines in
            lines.insert(line, at: 0)
            if lines.count > capacity { lines.removeLast(lines.count - capacity) }
        }
    }

    func log(_ message: String) {
        record(message)
        host.log(message)
    }

    func decryptFailed(sourceUserId: String, reason: String) {
        record("decrypt failed from \(sourceUserId): \(reason)")
        host.decryptFailed(sourceUserId: sourceUserId, reason: reason)
    }

    func ackFailed(envelopeId: String, reason: String) {
        record("ack failed for \(envelopeId): \(reason)")
        host.ackFailed(envelopeId: envelopeId, reason: reason)
    }

    func tokenRefreshFailed(attempt: Int, reason: String) {
        record("token refresh failed (attempt \(attempt)): \(reason)")
        host.tokenRefreshFailed(attempt: attempt, reason: reason)
    }

    func preKeyReplenishFailed(reason: String) {
        record("prekey replenish failed: \(reason)")
        host.preKeyReplenishFailed(reason: reason)
    }

    func identityChanged(userId: String) {
        record("identity changed for \(userId)")
        host.identityChanged(userId: userId)
    }

    func sessionEstablishFailed(userId: String, reason: String) {
        record("session establish failed for \(userId): \(reason)")
        host.sessionEstablishFailed(userId: userId, reason: reason)
    }

    func databaseError(store: String, operation: String, reason: String) {
        record("db error in \(store).\(operation): \(reason)")
        host.databaseError(store: store, operation: operation, reason: reason)
    }
}
