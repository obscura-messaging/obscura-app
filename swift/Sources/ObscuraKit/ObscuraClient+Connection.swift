import Foundation
import GRDB
import LibSignalClient

extension ObscuraClient {
    /// Returns once the gateway socket is open. Joins a connect in flight; cuts short a pending
    /// reconnect backoff. Safe to call on every app foreground.
    public func connect() async throws {
        try Task.checkCancellation()
        guard session != nil else { throw ObscuraError.notAuthenticated }
        startPreKeySync()
        do {
            if try PreKeys.isSyncDue(signalStore, nowMs: Int64(Self.nowMs())) { requestPreKeySync() }
        } catch {
            logger.databaseError(store: "signal", operation: "preKeyState", reason: "\(error)")
        }
        if connection.value == .connected { return }
        if let connectTask { return try await connectTask.value }
        reconnectTask?.cancel()
        reconnectTask = nil
        let generation = connectionGeneration
        let task = Task { try await self.openSocket(generation) }
        connectTask = task
        defer { if connectTask == task { connectTask = nil } }
        try await task.value
    }

    /// Closes the socket and stops reconnecting.
    public func disconnect() {
        connectionGeneration += 1
        recovering = false
        reconnectAttempts = 0
        connectTask?.cancel()
        connectTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.close()
        socket = nil
        connection.set(.disconnected)
    }

    private func openSocket(_ generation: Int) async throws {
        guard generation == connectionGeneration, !Task.isCancelled else { throw CancellationError() }
        connection.set(recovering ? .reconnecting : .connecting)
        do {
            guard try await freshToken() != .rejected else { throw ObscuraError.notAuthenticated }
            guard generation == connectionGeneration else { throw CancellationError() }
            let socket = try await GatewaySocket.open(gatewayURL(ticket: api.fetchGatewayTicket()), logger: logger)
            guard generation == connectionGeneration, session != nil else {
                socket.close()
                throw CancellationError()
            }
            install(socket)
        } catch {
            logger.log("gateway connect failed: \(error)")
            if generation == connectionGeneration {
                if recovering && session != nil { scheduleReconnect() } else { connection.set(.disconnected) }
            }
            if let error = error as? URLError {
                if error.code == .cancelled { throw CancellationError() }
                throw ObscuraError.connectionFailed(error.localizedDescription)
            }
            throw error
        }
    }

    private func gatewayURL(ticket: String) throws -> URL {
        guard var components = URLComponents(url: api.baseURL.appendingPathComponent("v1/gateway"), resolvingAgainstBaseURL: false) else {
            throw ObscuraError.invalidArgument("apiURL \(api.baseURL)")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let url = components.url else { throw ObscuraError.protocolViolation("gateway ticket is not URL-safe") }
        return url
    }

    private func install(_ socket: GatewaySocket) {
        self.socket = socket
        recovering = false
        reconnectAttempts = 0
        connection.set(.connected)
        receiveTask = Task { [weak self] in
            do {
                for try await event in socket.events {
                    await self?.handle(event, from: socket)
                }
            } catch {
                self?.logger.log("gateway closed: \(error)")
            }
            await self?.socketEnded(socket)
        }
    }

    private func socketEnded(_ ended: GatewaySocket) {
        guard socket === ended else { return }
        socket = nil
        recovering = true
        scheduleReconnect()
    }

    /// 1 s doubling to 30 s.
    private func scheduleReconnect() {
        let delay = min(UInt64(1) << UInt64(min(reconnectAttempts, 5)), 30)
        reconnectAttempts += 1
        connection.set(.reconnecting)
        logger.log("gateway reconnect in \(delay)s (attempt \(reconnectAttempts))")
        let generation = connectionGeneration
        reconnectTask = Task { [weak self] in
            guard (try? await Task.sleep(nanoseconds: delay * 1_000_000_000)) != nil else { return }
            await self?.reconnect(generation)
        }
    }

    private func reconnect(_ generation: Int) async {
        guard generation == connectionGeneration else { return }
        reconnectTask = nil
        // A failure has already been logged and the next attempt scheduled.
        _ = try? await connect()
    }

    private func handle(_ event: GatewayEvent, from socket: GatewaySocket) async {
        guard self.socket === socket, session != nil, !Task.isCancelled else { return }
        switch event {
        case .envelope(let envelope):
            await receive(envelope) { try await socket.acknowledge($0) }
        }
    }

    // MARK: - Prekeys

    /// For tests: sync timing takes effect at the next session's first sync request.
    func setPreKeySyncTiming(checkIntervalMs: UInt64, spacingMs: UInt64) {
        preKeyCheckIntervalMs = checkIntervalMs
        preKeySyncSpacingMs = spacingMs
    }

    func requestPreKeySync() {
        startPreKeySync()
        preKeySyncRequests?.yield()
    }

    /// Starts the session's sync task if it is not running: it syncs on each request, at least
    /// `preKeySyncSpacingMs` apart, and requests one every `preKeyCheckIntervalMs`.
    func startPreKeySync() {
        guard session != nil, preKeySyncTask == nil else { return }
        let generation = sessionGeneration
        let (requests, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        preKeySyncRequests = continuation
        let interval = preKeyCheckIntervalMs
        let spacing = preKeySyncSpacingMs
        preKeySyncTask = Task { [weak self] in
            let ticker = Task {
                while (try? await Task.sleep(nanoseconds: interval * 1_000_000)) != nil {
                    continuation.yield()
                }
            }
            defer { ticker.cancel() }
            // Ends when the session's end cancels this task or finishes the stream.
            for await _ in requests {
                guard let self else { return }
                await self.syncPreKeys(generation)
                guard (try? await Task.sleep(nanoseconds: spacing * 1_000_000)) != nil else { return }
            }
        }
    }

    /// Signal-Android's `PreKeysSyncJob`: ask the server how many one-time keys it still holds for this
    /// device, upload a refill of each kind it is short of and the signed and last-resort keys due for
    /// rotation, then clean up old keys.
    func syncPreKeys(_ generation: Int) async {
        guard generation == sessionGeneration, session != nil, !Task.isCancelled else { return }
        do {
            _ = try await requireFreshSession()
            guard generation == sessionGeneration, !Task.isCancelled else { return }
            let counts = try await api.fetchPreKeyCounts()
            let store = signalStore
            let now = Int64(Self.nowMs())
            // Off the actor: a Kyber batch takes a while to generate.
            let refill = try await Task.detached { try PreKeys.prepareRefill(store, counts: counts, nowMs: now) }.value
            if !refill.isEmpty { try await api.uploadPreKeys(refill.upload()) }
            guard generation == sessionGeneration else { return }
            try PreKeys.confirmRefill(signalStore, refill, nowMs: Int64(Self.nowMs()))
            if !refill.isEmpty { logger.log("prekeys uploaded (counts were \(counts.oneTime) EC, \(counts.kyber) Kyber)") }
        } catch is CancellationError {
            return
        } catch {
            logger.preKeySyncFailed(reason: "\(error)")
        }
    }
}
