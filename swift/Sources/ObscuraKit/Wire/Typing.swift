import Foundation

public enum TypingState: String, Sendable, Codable {
    case started
    case stopped
}

/// Who is typing where, from received typing signals. A `started` lasts 5 s from receipt unless
/// renewed; `stopped` ends it.
final class TypingTracker: Sendable {
    static let expiry: UInt64 = 5_000_000_000

    private struct Typer {
        let userId: String
        let token: UUID
        let expiry: Task<Void, Never>
    }

    private struct State {
        var typers: [String: [String: Typer]] = [:]  // contextId -> senderDeviceId -> typer
        var subscribers: [String: [UUID: AsyncStream<[String]>.Continuation]] = [:]
        var published: [String: [String]] = [:]
    }

    private let state = Locked(State())
    private let delivery = DispatchQueue(label: "ObscuraKit.typing-delivery")

    func started(contextId: String, userId: String, deviceId: String) {
        let token = UUID()
        let expiry = Task { [weak self] in
            guard (try? await Task.sleep(nanoseconds: Self.expiry)) != nil else { return }
            self?.expire(contextId: contextId, deviceId: deviceId, token: token)
        }
        update(contextId) { typers in
            typers[deviceId]?.expiry.cancel()
            typers[deviceId] = Typer(userId: userId, token: token, expiry: expiry)
        }
    }

    func stopped(contextId: String, deviceId: String) {
        update(contextId) { typers in typers.removeValue(forKey: deviceId)?.expiry.cancel() }
    }

    func clear() {
        state.withLock { state in
            for context in Array(state.typers.keys) {
                state.typers[context]?.values.forEach { $0.expiry.cancel() }
                state.typers[context] = nil
                publish(context, in: &state)
            }
        }
    }

    /// Distinct user ids typing in `contextId`, sorted. Yields on subscribe and on every change.
    func observe(contextId: String) -> AsyncStream<[String]> {
        AsyncStream { continuation in
            let id = UUID()
            state.withLock { state in
                let current = Self.userIds(contextId, in: state)
                delivery.async { continuation.yield(current) }
                state.subscribers[contextId, default: [:]][id] = continuation
            }
            continuation.onTermination = { [state] _ in
                state.withLock { _ = $0.subscribers[contextId]?.removeValue(forKey: id) }
            }
        }
    }

    private func expire(contextId: String, deviceId: String, token: UUID) {
        update(contextId) { typers in
            if typers[deviceId]?.token == token { typers[deviceId] = nil }
        }
    }

    private func update(_ contextId: String, _ change: (inout [String: Typer]) -> Void) {
        state.withLock { state in
            var typers = state.typers[contextId] ?? [:]
            change(&typers)
            state.typers[contextId] = typers.isEmpty ? nil : typers
            publish(contextId, in: &state)
        }
    }

    private func publish(_ contextId: String, in state: inout State) {
        let current = Self.userIds(contextId, in: state)
        guard current != (state.published[contextId] ?? []) else { return }
        state.published[contextId] = current.isEmpty ? nil : current
        let subscribers = Array((state.subscribers[contextId] ?? [:]).values)
        delivery.async { subscribers.forEach { $0.yield(current) } }
    }

    private static func userIds(_ contextId: String, in state: State) -> [String] {
        Set((state.typers[contextId] ?? [:]).values.map(\.userId)).sorted()
    }
}
