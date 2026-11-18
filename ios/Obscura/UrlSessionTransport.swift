import Foundation
import ObscuraCore

/// OS-native HTTP and WebSocket transport for `ObscuraCore.ObscuraClient` backed by `URLSession`.
final class UrlSessionTransport: Transport, @unchecked Sendable {
    private let httpSession: URLSession

    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 15
        self.httpSession = URLSession(configuration: config)
    }

    func execute(request: HttpRequest) async throws -> HttpResponse {
        guard let url = URL(string: request.url) else {
            throw ObscuraError.InvalidArgument(reason: "Invalid URL: \(request.url)")
        }
        var urlRequest = URLRequest(url: url, timeoutInterval: 15)
        urlRequest.httpMethod = request.method
        for (field, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }

        do {
            let data: Data
            let response: URLResponse
            if let responseFilePath = request.responseFilePath {
                if let bodyFilePath = request.bodyFilePath {
                    urlRequest.httpBody = try Data(
                        contentsOf: URL(fileURLWithPath: bodyFilePath),
                        options: .mappedIfSafe
                    )
                } else {
                    urlRequest.httpBody = request.body
                }
                let (tempURL, resp) = try await httpSession.download(for: urlRequest)
                response = resp
                if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    let destURL = URL(fileURLWithPath: responseFilePath)
                    let parentDir = destURL.deletingLastPathComponent()
                    try FileManager.default.createDirectory(at: parentDir, withIntermediateDirectories: true)
                    if FileManager.default.fileExists(atPath: destURL.path) {
                        try FileManager.default.removeItem(at: destURL)
                    }
                    try FileManager.default.moveItem(at: tempURL, to: destURL)
                    data = Data()
                } else {
                    data = (try? Data(contentsOf: tempURL)) ?? Data()
                }
            } else if let bodyFilePath = request.bodyFilePath {
                let fileURL = URL(fileURLWithPath: bodyFilePath)
                (data, response) = try await httpSession.upload(for: urlRequest, fromFile: fileURL)
            } else {
                urlRequest.httpBody = request.body
                (data, response) = try await httpSession.data(for: urlRequest)
            }

            guard let http = response as? HTTPURLResponse else {
                throw ObscuraError.ProtocolViolation(reason: "Non-HTTP response for \(request.url)")
            }
            return HttpResponse(
                status: UInt16(clamping: http.statusCode),
                body: data,
                retryAfter: http.value(forHTTPHeaderField: "Retry-After")
            )
        } catch let error as ObscuraError {
            throw error
        } catch let error as URLError {
            throw ObscuraError.ConnectionFailed(reason: error.localizedDescription)
        } catch {
            throw ObscuraError.ConnectionFailed(reason: error.localizedDescription)
        }
    }

    func openWebsocket(url: String, sink: WebSocketSink) throws -> WebSocketHandle {
        guard let wsURL = URL(string: url) else {
            throw ObscuraError.ConnectionFailed(reason: "Invalid WebSocket URL: \(url)")
        }
        return UrlSessionWebSocketHandle(url: wsURL, sink: sink)
    }
}

private final class UrlSessionWebSocketHandle: NSObject, WebSocketHandle, URLSessionWebSocketDelegate, @unchecked Sendable {
    private static let pingIntervalNanoseconds: UInt64 = 30 * 1_000_000_000

    private let sink: WebSocketSink
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var loops: [Task<Void, Never>] = []
    private var closed = false

    init(url: URL, sink: WebSocketSink) {
        self.sink = sink
        super.init()
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
    }

    func send(bytes: Data) throws {
        lock.lock()
        let currentTask = closed ? nil : task
        lock.unlock()
        guard let currentTask else {
            throw ObscuraError.ConnectionFailed(reason: "Socket is closing")
        }
        currentTask.send(.data(bytes)) { [weak self] error in
            if let error {
                self?.closeAndNotify(reason: error.localizedDescription)
            }
        }
    }

    func closeSocket() {
        closeInternal()
    }

    private func closeAndNotify(reason: String) {
        if closeInternal() {
            sink.onClosed(reason: reason)
        }
    }

    @discardableResult
    private func closeInternal() -> Bool {
        lock.lock()
        if closed {
            lock.unlock()
            return false
        }
        closed = true
        let currentLoops = loops
        let currentTask = task
        let currentSession = session
        loops = []
        task = nil
        session = nil
        lock.unlock()

        currentLoops.forEach { $0.cancel() }
        currentTask?.cancel(with: .normalClosure, reason: nil)
        currentSession?.invalidateAndCancel()
        return true
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        lock.lock()
        if closed {
            lock.unlock()
            webSocketTask.cancel(with: .normalClosure, reason: nil)
            session.invalidateAndCancel()
            return
        }
        let receiveLoop = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await webSocketTask.receive()
                    guard let self else { return }
                    switch message {
                    case .data(let data):
                        self.sink.onBinary(bytes: data)
                    case .string(let text):
                        self.sink.onText(text: text)
                    @unknown default:
                        break
                    }
                }
            } catch {
                self?.closeAndNotify(reason: error.localizedDescription)
            }
        }
        let pingLoop = Task { [weak self] in
            while (try? await Task.sleep(nanoseconds: Self.pingIntervalNanoseconds)) != nil {
                guard !Task.isCancelled else { return }
                webSocketTask.sendPing { [weak self] error in
                    if let error {
                        self?.closeAndNotify(reason: error.localizedDescription)
                    }
                }
            }
        }
        loops = [receiveLoop, pingLoop]
        lock.unlock()

        sink.onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        closeAndNotify(reason: "closed by server (code \(closeCode.rawValue))")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        closeAndNotify(reason: error?.localizedDescription ?? "socket completed")
    }
}
