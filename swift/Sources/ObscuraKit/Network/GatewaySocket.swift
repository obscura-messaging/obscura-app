import Foundation
import SwiftProtobuf

struct Envelope: Sendable {
    let id: Data
    let senderUserId: Data
    let senderDeviceId: Data
    let message: Data
}

enum GatewayEvent: Sendable {
    case envelope(Envelope)
    case preKeyStatus(count: Int32, threshold: Int32)
}

/// One gateway WebSocket. `events` finishes when the socket closes for any reason; a reconnect opens
/// a new socket.
final class GatewaySocket: NSObject, URLSessionWebSocketDelegate, Sendable {
    static let pingInterval: UInt64 = 30

    let events: AsyncThrowingStream<GatewayEvent, Error>
    private let continuation: AsyncThrowingStream<GatewayEvent, Error>.Continuation
    private let logger: ObscuraLogger

    private struct State {
        var session: URLSession?
        var task: URLSessionWebSocketTask?
        var opening: CheckedContinuation<Void, Error>?
        var loops: [Task<Void, Never>] = []
        var closed = false
    }

    private let state = Locked(State())

    private init(logger: ObscuraLogger) {
        (events, continuation) = AsyncThrowingStream.makeStream()
        self.logger = logger
    }

    /// Returns once the socket is open.
    static func open(_ url: URL, logger: ObscuraLogger) async throws -> GatewaySocket {
        let socket = GatewaySocket(logger: logger)
        try await withTaskCancellationHandler {
            try await socket.start(url)
        } onCancel: {
            socket.close()
        }
        return socket
    }

    private func start(_ url: URL) async throws {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        try await withCheckedThrowingContinuation { (opening: CheckedContinuation<Void, Error>) in
            let closed = state.withLock { state -> Bool in
                guard !state.closed else { return true }
                state.session = session
                state.task = task
                state.opening = opening
                return false
            }
            if closed {
                session.invalidateAndCancel()
                opening.resume(throwing: CancellationError())
            } else {
                task.resume()
            }
        }
        let receive = Task { [weak self] in
            do {
                while true {
                    if case .data(let data) = try await task.receive() { self?.handle(data) }
                }
            } catch {
                self?.finish(error)
            }
        }
        let ping = Task { [weak self] in
            while (try? await Task.sleep(nanoseconds: Self.pingInterval * 1_000_000_000)) != nil {
                task.sendPing { error in
                    guard let error, let self else { return }
                    self.logger.log("gateway ping failed: \(error)")
                    self.finish(error)
                }
            }
        }
        let closed = state.withLock { state in
            guard !state.closed else { return true }
            state.loops = [receive, ping]
            return false
        }
        if closed {
            receive.cancel()
            ping.cancel()
        }
    }

    func acknowledge(_ envelopeId: Data) async throws {
        guard let task = state.withLock({ $0.task }) else { throw ObscuraError.connectionFailed("socket closed") }
        var frame = Obscura_V1_WebSocketFrame()
        frame.ack.messageIds = [envelopeId]
        try await task.send(.data(frame.serializedData()))
    }

    func close() {
        finish(nil)
    }

    private func finish(_ error: Error?) {
        let state = self.state.withLock { state -> State? in
            guard !state.closed else { return nil }
            state.closed = true
            let previous = state
            state.opening = nil
            state.task = nil
            state.session = nil
            state.loops = []
            return previous
        }
        guard let state else { return }
        state.loops.forEach { $0.cancel() }
        state.task?.cancel(with: .goingAway, reason: nil)
        state.session?.invalidateAndCancel()
        state.opening?.resume(throwing: error ?? CancellationError())
        continuation.finish(throwing: error)
    }

    private func handle(_ data: Data) {
        let frame: Obscura_V1_WebSocketFrame
        do {
            frame = try Obscura_V1_WebSocketFrame(serializedBytes: data)
        } catch {
            logger.log("gateway frame parse failed (\(data.count) bytes): \(error)")
            finish(ObscuraError.protocolViolation("malformed gateway frame"))
            return
        }
        switch frame.payload {
        case .envelopeBatch(let batch)?:
            for envelope in batch.envelopes {
                continuation.yield(.envelope(Envelope(id: envelope.id, senderUserId: envelope.senderUserID,
                                                      senderDeviceId: envelope.senderDeviceID, message: envelope.message)))
            }
        case .preKeyStatus(let status)?:
            continuation.yield(.preKeyStatus(count: status.oneTimePreKeyCount, threshold: status.minThreshold))
        default:
            break
        }
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        let opening = state.withLock { state in
            let opening = state.opening
            state.opening = nil
            return opening
        }
        opening?.resume()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(ObscuraError.connectionFailed("closed by server (code \(closeCode.rawValue))"))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error ?? ObscuraError.connectionFailed("socket completed"))
    }
}
