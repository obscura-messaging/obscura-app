import Foundation
import Network
import XCTest
@testable import ObscuraKit

final class FakeGatewayServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "FakeGatewayServer")
    private let lock = NSLock()
    private var connections: [NWConnection] = []
    private var receivedFrames: [Obscura_V1_WebSocketFrame] = []
    private var onConnectCallbacks: [(NWConnection) -> Void] = []

    private(set) var port: UInt16 = 0

    init() throws {
        let parameters = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        listener = try NWListener(using: parameters, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed, .cancelled:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        listener.start(queue: queue)
        ready.wait()
        guard let assignedPort = listener.port?.rawValue else {
            throw ObscuraError.connectionFailed("NWListener failed to bind port")
        }
        self.port = assignedPort
    }

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { [weak self] state in
            if case .ready = state, let self {
                let callbacks = self.lock.withLock { () -> [(NWConnection) -> Void] in
                    self.connections.append(conn)
                    let cbs = self.onConnectCallbacks
                    self.onConnectCallbacks.removeAll()
                    return cbs
                }
                for cb in callbacks { cb(conn) }
                self.readLoop(conn)
            }
        }
        conn.start(queue: queue)
    }

    private func readLoop(_ conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty, let frame = try? Obscura_V1_WebSocketFrame(serializedBytes: data) {
                self.lock.withLock { self.receivedFrames.append(frame) }
            }
            if error == nil {
                self.readLoop(conn)
            }
        }
    }

    func waitForConnection(timeout: TimeInterval = 5) async throws -> NWConnection {
        if let existing = lock.withLock({ connections.last }) {
            return existing
        }
        return try await withCheckedThrowingContinuation { continuation in
            lock.withLock {
                if let existing = connections.last {
                    continuation.resume(returning: existing)
                } else {
                    onConnectCallbacks.append { conn in
                        continuation.resume(returning: conn)
                    }
                }
            }
        }
    }

    func sendBinary(_ data: Data) {
        let conns = lock.withLock { connections }
        let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
        let ctx = NWConnection.ContentContext(identifier: "bin", metadata: [meta])
        for conn in conns {
            conn.send(content: data, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
        }
    }

    func sendText(_ text: String) {
        let conns = lock.withLock { connections }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "txt", metadata: [meta])
        for conn in conns {
            conn.send(content: Data(text.utf8), contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in })
        }
    }

    func sendClose() {
        let conns = lock.withLock { connections }
        let meta = NWProtocolWebSocket.Metadata(opcode: .close)
        meta.closeCode = .protocolCode(.normalClosure)
        let ctx = NWConnection.ContentContext(identifier: "close", metadata: [meta])
        for conn in conns {
            conn.send(content: nil, contentContext: ctx, isComplete: true, completion: .contentProcessed { _ in
                conn.cancel()
            })
        }
    }

    func ackedIds() -> [Data] {
        lock.withLock { receivedFrames.flatMap(\.ack.messageIds) }
    }

    func close() {
        let conns = lock.withLock {
            let c = connections
            connections.removeAll()
            return c
        }
        for conn in conns { conn.cancel() }
        listener.cancel()
    }
}

final class GatewayAndConnectionTests: XCTestCase {
    func testGatewaySocketOpenReceiveEventsAcknowledgeAndClose() async throws {
        let gw = try FakeGatewayServer()
        defer { gw.close() }
        let logger = RecordingLogger(SilentLogger())
        let url = URL(string: "ws://127.0.0.1:\(gw.port)/v1/gateway?ticket=t")!

        let socket = try await GatewaySocket.open(url, logger: logger)
        _ = try await gw.waitForConnection()

        // A text frame, an empty frame and a retired pre_key_status frame (field 12) are ignored; then an envelopeBatch.
        gw.sendText("ignore-text")
        gw.sendBinary(try Obscura_V1_WebSocketFrame().serializedData())
        gw.sendBinary(Data([0x62, 0x02, 0x08, 0x03]))

        let envId = uuidBytes(UUID().uuidString)!
        var envProto = Obscura_V1_Envelope()
        envProto.id = envId
        envProto.senderUserID = uuidBytes(UUID().uuidString)!
        envProto.senderDeviceID = uuidBytes(UUID().uuidString)!
        envProto.message = Data([1, 2, 3])
        var batchFrame = Obscura_V1_WebSocketFrame()
        batchFrame.envelopeBatch.envelopes = [envProto]
        gw.sendBinary(try batchFrame.serializedData())

        var iterator = socket.events.makeAsyncIterator()
        let firstEvent = try await iterator.next()
        guard case .envelope(let env)? = firstEvent else {
            return XCTFail("expected envelope event, got \(String(describing: firstEvent))")
        }
        XCTAssertEqual(env.id, envId)

        try await socket.acknowledge(envId)
        for _ in 0..<40 {
            if gw.ackedIds().contains(envId) { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertEqual(gw.ackedIds(), [envId])

        socket.close()
        await assertThrows(.connectionFailed("socket closed")) {
            try await socket.acknowledge(envId)
        }
    }

    func testGatewaySocketMalformedFrameAndServerClose() async throws {
        let gw = try FakeGatewayServer()
        defer { gw.close() }
        let logger = RecordingLogger(SilentLogger())
        let url = URL(string: "ws://127.0.0.1:\(gw.port)/v1/gateway?ticket=t")!

        let socket1 = try await GatewaySocket.open(url, logger: logger)
        _ = try await gw.waitForConnection()
        gw.sendBinary(Data([0xff, 0xff, 0xff]))

        var iter1 = socket1.events.makeAsyncIterator()
        do {
            _ = try await iter1.next()
            XCTFail("malformed frame must throw")
        } catch {
            XCTAssertEqual(error as? ObscuraError, .protocolViolation("malformed gateway frame"))
        }
        XCTAssertTrue(logger.snapshot().contains { $0.contains("gateway frame parse failed") })

        let socket2 = try await GatewaySocket.open(url, logger: logger)
        _ = try await gw.waitForConnection()
        gw.sendClose()
        var iter2 = socket2.events.makeAsyncIterator()
        do {
            _ = try await iter2.next()
            XCTFail("server close must fail stream")
        } catch {
            XCTAssertNotNil(error)
        }
    }

    func testClientConnectReceivesAndAcknowledgesEnvelopesOverGateway() async throws {
        let server = FakeObscuraServer()
        defer { server.close() }
        let gw = try FakeGatewayServer()
        defer { gw.close() }
        server.setGatewayTicket("valid-ticket")

        let phone = try await server.register(UUID().uuidString.lowercased())
        let bob = try await server.register(UUID().uuidString.lowercased())
        let client = try makeClient(apiURL: "http://127.0.0.1:\(gw.port)", database: phone.db)
        try await client.begin(Session(
            token: phone.deviceId, refreshToken: "rt",
            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
            userId: phone.userId, deviceId: phone.deviceId, username: "alice"
        ))

        try await client.connect()
        try await client.connect()
        XCTAssertEqual(client.connectionState, .connected)
        _ = try await gw.waitForConnection()

        try await send(clientMessage {
            $0.timestamp = 1_000
            $0.directMessage.id = "gw_msg_1"
            $0.directMessage.peerUserID = phone.userId
            $0.directMessage.content = "over websocket"
        }, from: bob, to: phone.userId)
        let pendingEnv = try XCTUnwrap(phone.envelopes().first)
        var envProto = Obscura_V1_Envelope()
        envProto.id = pendingEnv.id
        envProto.senderUserID = pendingEnv.senderUserId
        envProto.senderDeviceID = pendingEnv.senderDeviceId
        envProto.message = pendingEnv.message
        var batchFrame = Obscura_V1_WebSocketFrame()
        batchFrame.envelopeBatch.envelopes = [envProto]
        gw.sendBinary(try batchFrame.serializedData())

        for _ in 0..<40 {
            if (try? await client.getMessages().count) == 1, gw.ackedIds().contains(pendingEnv.id) { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        let messages = try await client.getMessages()
        XCTAssertEqual(messages.map(\.id), ["gw_msg_1"])
        XCTAssertEqual(gw.ackedIds(), [pendingEnv.id])

        await client.disconnect()
        XCTAssertEqual(client.connectionState, .disconnected)
        try await client.logout()
    }

    func testAConnectedClientChecksItsSupplyPeriodicallyAndLogsAFailedSync() async throws {
        let server = FakeObscuraServer()
        defer { server.close() }
        let gw = try FakeGatewayServer()
        defer { gw.close() }
        server.setGatewayTicket("valid-ticket")

        let phone = try await server.register(UUID().uuidString.lowercased())
        let client = try makeClient(apiURL: "http://127.0.0.1:\(gw.port)", database: phone.db)
        try await client.begin(Session(
            token: phone.deviceId, refreshToken: "rt",
            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
            userId: phone.userId, deviceId: phone.deviceId, username: "alice"
        ))

        // Bundle fetches used up keys without any message to say so; only the periodic check notices.
        server.setPreKeyCounts(OneTimePreKeyCounts(oneTime: 0, kyber: 3))
        await client.setPreKeySyncTiming(checkIntervalMs: 100, spacingMs: 0)
        try await client.connect()
        _ = try await gw.waitForConnection()

        for _ in 0..<100 where server.preKeyUploadCount() == 0 {
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertEqual(Set(server.preKeyUploadBodies().first?.keys.map { $0 } ?? []), ["oneTimePreKeys", "kyberPreKeys"])

        server.failPreKeyUpload(status: 500)
        server.setPreKeyCounts(OneTimePreKeyCounts(oneTime: 0, kyber: 100))
        for _ in 0..<100 where !client.getDebugLog().contains(where: { $0.contains("prekey sync failed") }) {
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertTrue(client.getDebugLog().contains { $0.contains("prekey sync failed") })

        await client.disconnect()
        try await client.logout()
    }

    func testGatewayDropReconnectsAndCompleteLinkConnects() async throws {
        let server = FakeObscuraServer()
        defer { server.close() }
        let gw = try FakeGatewayServer()
        defer { gw.close() }
        server.setGatewayTicket("valid-ticket")

        let phone = try await server.register(UUID().uuidString.lowercased())
        server.account("alice", userId: phone.userId)
        let client = try makeClient(apiURL: "http://127.0.0.1:\(gw.port)", database: phone.db)
        try await client.begin(Session(
            token: phone.deviceId, refreshToken: "rt",
            expiresAt: Int64(Date().timeIntervalSince1970) + 3600,
            userId: phone.userId, deviceId: phone.deviceId, username: "alice"
        ))

        try await client.connect()
        _ = try await gw.waitForConnection()

        // Await transitions rather than sampling the state: reconnecting can last only as long as the
        // 1 s backoff, so a poll on a slow simulator can miss it entirely.
        let states = client.observeConnectionState() // subscribes now, while still connected
        let transitions = Task {
            var seen: [ConnectionState] = []
            for await state in states.dropFirst() {
                seen.append(state)
                if state == .connected { break }
            }
            return seen
        }
        let timeout = Task {
            try await Task.sleep(nanoseconds: 15_000_000_000)
            transitions.cancel()
        }
        defer { timeout.cancel() }
        gw.sendClose()
        let seen = await transitions.value
        XCTAssertEqual(seen, [.reconnecting, .connected])
        await client.disconnect()

        let linkClient = try makeClient(apiURL: "http://127.0.0.1:\(gw.port)")
        let req = try await linkClient.beginLink("alice", "password", deviceName: "LiveLink")
        try await client.approveLink(req.code)
        try await linkClient.completeLink(req)
        XCTAssertEqual(linkClient.authState, .authenticated)
        XCTAssertEqual(linkClient.connectionState, .connected)
        await linkClient.disconnect()
        try await linkClient.logout()
        try await client.logout()
    }

    func testPersistIgnoresDuplicateEnvelopeAndSessionRejectsInvalidAuthResponse() async throws {
        let gw = try FakeGatewayServer()
        defer { gw.close() }

        let cancelledOpen = Task {
            try await GatewaySocket.open(URL(string: "ws://127.0.0.1:\(gw.port)/v1/gateway?ticket=t")!, logger: SilentLogger())
        }
        cancelledOpen.cancel()
        do {
            let s = try await cancelledOpen.value
            s.close()
            XCTFail("expected pre-cancelled GatewaySocket.open to throw CancellationError")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }

        let db = try ObscuraDatabase.inMemory()
        let dupOutcome = try await db.write { db -> PersistedContent in
            try ContentStore.recordEnvelope("dup-env", in: db)
            return try ObscuraClient.persist(
                Obscura_Client_V1_ClientMessage(), envelopeId: "dup-env",
                senderUserId: "u", senderDeviceId: "d", selfUserId: "u", in: db
            )
        }
        XCTAssertEqual(dupOutcome, .handled)

        let client = try makeClient()
        let badAuth = AuthResponse(token: "", refreshToken: "r", expiresAt: 100, userId: "not-uuid", deviceId: "not-uuid")
        await assertThrows(.protocolViolation("invalid auth response")) {
            _ = try await client.session(badAuth, username: "u")
        }
    }
}
