import Foundation
import GRDB
import LibSignalClient
@testable import ObscuraKit

/// An in-process stand-in for the device, bundle and message endpoints with the real server's
/// semantics. All devices of a user share the account identity; the first one registered is the
/// primary. `GET /v1/keys/{id}` returns one bundle per device and consumes a one-time prekey from each
/// (404 when the user has none), `GET /v1/keys/{id}/devices/{device}` consumes one from that device
/// only, and `POST /v1/messages` enforces complete delivery for every named or targeted user: a user's
/// submissions are all rejected with a `device_mismatches` entry unless they cover the user's devices
/// other than the sender, and
/// a submission for an unknown device is reported in `invalid_device_ids`. Refresh
/// tokens are rejected unless ``acceptRefresh(token:refreshToken:)`` says otherwise. `GET /v1/keys`
/// reports ``preKeyCounts``, plenty by default, and `POST /v1/keys` records each upload.
///
/// Served through ``FakeServerProtocol`` for requests to ``host``; one server is active at a time.
final class FakeObscuraServer: @unchecked Sendable {
    static let host = "sender-unit.invalid"
    static var baseURL: String { "https://\(host)" }
    nonisolated(unsafe) static var active: FakeObscuraServer?

    private let lock = NSLock()
    private var devices: [String: FakeDevice] = [:]
    private var order: [String] = []
    private var userFetches: [String: Int] = [:]
    private var deviceFetches: [String: Int] = [:]
    private var listFetches: [String: Int] = [:]
    private var listStatus = 200
    private(set) var idempotencyKeys: [String] = []

    private var accounts: [String: String] = [:]
    private var sessionTokens: [String: String] = [:]
    private var linkSessions: [String: (userId: String, body: Data?)] = [:]
    private var attachments: [String: Data] = [:]
    private var createDeviceStatus = 201
    private var tokenRejections = 0
    private var refreshStatus = 401
    private var refreshed: [String: Any]?
    private var offline = false
    private var totalRequests = 0
    private var preKeyUploads: [[String: Any]] = []
    private var preKeyStatus = 204
    private var counts = PreKeyCounts(oneTime: 100, kyber: 100)
    private var countChecks = 0
    private var pushTokens: [String] = []
    private var customDevicesResponse: [[String: Any]]?
    private var gatewayTicket: String?

    func failDeviceList(status: Int) { lock.withLock { listStatus = status } }
    func setCustomDevicesResponse(_ list: [[String: Any]]?) { lock.withLock { customDevicesResponse = list } }
    func failDeviceCreation(status: Int) { lock.withLock { createDeviceStatus = status } }
    func failPreKeyUpload(status: Int) { lock.withLock { preKeyStatus = status } }
    func failRefresh(status: Int) { lock.withLock { refreshed = nil; refreshStatus = status } }
    func setOffline(_ isOffline: Bool = true) { lock.withLock { offline = isOffline } }
    fileprivate var isOffline: Bool { lock.withLock { offline } }
    func requestCount() -> Int { lock.withLock { totalRequests } }
    func resetRequestCount() { lock.withLock { totalRequests = 0 } }
    fileprivate func recordRequest() { lock.withLock { totalRequests += 1 } }
    func setGatewayTicket(_ ticket: String?) { lock.withLock { gatewayTicket = ticket } }
    func preKeyUploadCount() -> Int { lock.withLock { preKeyUploads.count } }
    /// The JSON body of each `POST /v1/keys`, in order.
    func preKeyUploadBodies() -> [[String: Any]] { lock.withLock { preKeyUploads } }
    /// What `GET /v1/keys` reports.
    func setPreKeyCounts(_ value: PreKeyCounts) { lock.withLock { counts = value } }
    func preKeyCountChecks() -> Int { lock.withLock { countChecks } }
    func registeredPushTokens() -> [String] { lock.withLock { pushTokens } }
    /// Answers the next `count` token-authenticated requests with 401.
    func rejectTokens(_ count: Int) { lock.withLock { tokenRejections = count } }
    /// Lets refreshes succeed with these tokens instead of being rejected.
    func acceptRefresh(token: String, refreshToken: String, userId: String = "u1", deviceId: String = "d1") {
        lock.withLock {
            sessionTokens[token] = userId
            refreshed = [
                "token": token,
                "refreshToken": refreshToken,
                "expiresAt": Int(Date().timeIntervalSince1970) + 3600,
                "userId": userId,
                "deviceId": deviceId,
            ]
        }
    }

    /// Lets `username` log in (any password) as `userId`.
    func account(_ username: String, userId: String) { lock.withLock { accounts[username] = userId } }
    func linkSession(_ id: String) -> (userId: String, body: Data?)? { lock.withLock { linkSessions[id] } }
    func approve(_ id: String, body: Data) { lock.withLock { linkSessions[id]?.body = body } }
    func attachment(_ id: String) -> Data? { lock.withLock { attachments[id] } }

    init() {
        Self.active = self
        URLProtocol.registerClass(FakeServerProtocol.self)
    }

    func close() {
        FakeServerProtocol.onDeviceList.withLock { $0 = nil }
        FakeServerProtocol.onRefresh.withLock { $0 = nil }
        FakeServerProtocol.pendingRefresh.withLock { $0 = nil }
        FakeServerProtocol.messageResponse.withLock { $0 = nil }
        URLProtocol.unregisterClass(FakeServerProtocol.self)
        Self.active = nil
    }

    /// Whole-user bundle fetches for `userId`, each of which consumed a prekey on every device.
    func bundleFetches(_ userId: String) -> Int { lock.withLock { userFetches[userId] ?? 0 } }
    /// Single-device bundle fetches for `deviceId`.
    func deviceBundleFetches(_ deviceId: String) -> Int { lock.withLock { deviceFetches[deviceId] ?? 0 } }
    func deviceListFetches(_ userId: String) -> Int { lock.withLock { listFetches[userId] ?? 0 } }
    func messageRequests() -> Int { lock.withLock { idempotencyKeys.count } }

    /// A new device of `userId`: the primary with a new identity for a new user, otherwise a linked
    /// device holding the account identity.
    /// `rogueIdentity` gives a device of an existing user an identity other than the account's.
    /// `corruptBundle` and `corruptKyber` zero the signature on its signed or Kyber prekey.
    func register(_ userId: String, corruptBundle: Bool = false, corruptKyber: Bool = false,
                  rogueIdentity: Bool = false) async throws -> FakeDevice {
        let primary = lock.withLock { devices.values.first { $0.userId == userId && $0.isPrimary } }
        let device = try await FakeDevice(userId: userId, primary: primary, corruptBundle: corruptBundle,
                                          corruptKyber: corruptKyber, rogueIdentity: rogueIdentity)
        lock.withLock {
            devices[device.deviceId] = device
            order.append(device.deviceId)
        }
        return device
    }

    /// An account reset: every device of the user is deleted, and a new primary with a new identity
    /// takes their place.
    func reset(_ userId: String) async throws -> FakeDevice {
        lock.withLock { devices = devices.filter { $0.value.userId != userId } }
        return try await register(userId)
    }

    func remove(_ device: FakeDevice) { lock.withLock { _ = devices.removeValue(forKey: device.deviceId) } }

    fileprivate func handle(_ request: URLRequest, body: Data) -> (Int, Data) {
        let path = request.url!.path
        let token = request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "") ?? ""
        let callerDevice = token
        if !token.isEmpty, !path.hasPrefix("/v1/session"), lock.withLock({
            defer { tokenRejections = max(0, tokenRejections - 1) }
            return tokenRejections > 0
        }) { return (401, Data()) }
        if request.httpMethod == "GET", path == "/v1/devices" { return deviceList(token) }
        if request.httpMethod == "POST", path == "/v1/users" {
            return lock.withLock {
                let payload = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
                let username = payload["username"] as? String ?? "user"
                let userId = accounts[username] ?? UUID().uuidString.lowercased()
                accounts[username] = userId
                let deviceId = UUID().uuidString.lowercased()
                sessionTokens[deviceId] = userId
                let response: [String: Any] = [
                    "token": deviceId,
                    "refreshToken": "rt",
                    "expiresAt": Int(Date().timeIntervalSince1970) + 3600,
                    "userId": userId,
                    "deviceId": deviceId,
                ]
                return (201, try! JSONSerialization.data(withJSONObject: response))
            }
        }
        if request.httpMethod == "POST", path == "/v1/session" { return login(body) }
        if request.httpMethod == "POST", path == "/v1/devices" {
            return lock.withLock {
                guard createDeviceStatus == 201 else { return (createDeviceStatus, Data()) }
                let payload = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
                let sessionId = payload["linkSessionId"] as? String ?? ""
                let userId = linkSessions[sessionId]?.userId ?? UUID().uuidString.lowercased()
                let deviceId = UUID().uuidString.lowercased()
                sessionTokens[deviceId] = userId
                let response: [String: Any] = [
                    "token": deviceId,
                    "refreshToken": "rt",
                    "expiresAt": Int(Date().timeIntervalSince1970) + 3600,
                    "userId": userId,
                    "deviceId": deviceId,
                ]
                return (201, try! JSONSerialization.data(withJSONObject: response))
            }
        }
        if path.hasPrefix("/v1/link-sessions") { return link(request, token: token, body: body) }
        if request.httpMethod == "POST", path == "/v1/attachments" {
            let id = UUID().uuidString.lowercased()
            lock.withLock { attachments[id] = body }
            return (201, Data(#"{"id":"\#(id)"}"#.utf8))
        }
        if request.httpMethod == "GET", path.hasPrefix("/v1/attachments/") {
            return lock.withLock { attachments[String(path.dropFirst("/v1/attachments/".count))].map { (200, $0) } ?? (404, Data()) }
        }
        if request.httpMethod == "POST", path == "/v1/keys" {
            return lock.withLock {
                guard preKeyStatus == 204 else { return (preKeyStatus, Data("prekey upload failed".utf8)) }
                preKeyUploads.append((try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:])
                return (204, Data())
            }
        }
        if request.httpMethod == "GET", path == "/v1/keys" {
            return lock.withLock {
                countChecks += 1
                return (200, Data(#"{"oneTimePreKeyCount":\#(counts.oneTime),"kyberPreKeyCount":\#(counts.kyber)}"#.utf8))
            }
        }
        if request.httpMethod == "PUT", path == "/v1/push-token" {
            return lock.withLock {
                if let payload = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                   let pushToken = payload["token"] {
                    pushTokens.append(pushToken)
                }
                return (204, Data())
            }
        }
        if request.httpMethod == "GET", path.hasPrefix("/v1/keys/") {
            let parts = path.dropFirst("/v1/keys/".count).split(separator: "/").map(String.init)
            return parts.count == 3 ? bundle(parts[0], deviceId: parts[2]) : bundles(parts[0])
        }
        if request.httpMethod == "POST", path == "/v1/messages" {
            lock.withLock { idempotencyKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "") }
            return accept(from: callerDevice, body)
        }
        if request.httpMethod == "POST", path == "/v1/gateway/ticket" {
            return lock.withLock {
                guard caller(token) != nil else { return (401, Data()) }
                if let ticket = gatewayTicket {
                    return (200, Data(#"{"ticket":"\#(ticket)"}"#.utf8))
                }
                return (503, Data("fake gateway is unavailable".utf8))
            }
        }
        if request.httpMethod == "DELETE", path == "/v1/session" { return (204, Data()) }
        if path == "/v1/session/refresh" {
            let accepted: [String: Any]? = lock.withLock { refreshed }
            if let accepted {
                // Slow enough that concurrent callers overlap.
                Thread.sleep(forTimeInterval: 0.2)
                return (200, try! JSONSerialization.data(withJSONObject: accepted))
            }
            return lock.withLock { (refreshStatus, Data("{}".utf8)) }
        }
        if request.httpMethod == "DELETE", path.hasPrefix("/v1/devices/") {
            return lock.withLock {
                devices.removeValue(forKey: String(path.dropFirst("/v1/devices/".count))) == nil ? (404, Data()) : (204, Data())
            }
        }
        if request.httpMethod == "POST", path == "/v1/users/reset" {
            return lock.withLock {
                let request = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
                guard let username = request["username"] as? String, let userId = accounts[username] else { return (401, Data()) }
                devices = devices.filter { $0.value.userId != userId }
                let newDeviceId = UUID().uuidString.lowercased()
                sessionTokens[newDeviceId] = userId
                let response: [String: Any] = [
                    "token": newDeviceId,
                    "refreshToken": "rt",
                    "expiresAt": Int(Date().timeIntervalSince1970) + 3600,
                    "userId": userId,
                    "deviceId": newDeviceId,
                ]
                return (200, try! JSONSerialization.data(withJSONObject: response))
            }
        }
        return (404, Data())
    }

    private func owned(_ userId: String) -> [FakeDevice] {
        order.compactMap { devices[$0] }.filter { $0.userId == userId }
    }

    private func caller(_ token: String) -> String? {
        devices[token]?.userId ?? sessionTokens[token]
    }

    private func login(_ body: Data) -> (Int, Data) {
        lock.withLock {
            let request = try! JSONSerialization.jsonObject(with: body) as! [String: String]
            guard let userId = accounts[request["username"]!] else { return (401, Data()) }
            guard let deviceId = request["deviceId"], devices[deviceId]?.userId == userId else {
                return (409, Data(#"{"error":"Device does not belong to this account"}"#.utf8))
            }
            let response: [String: Any] = [
                "token": deviceId,
                "refreshToken": "rt",
                "expiresAt": Int(Date().timeIntervalSince1970) + 3600,
                "userId": userId,
                "deviceId": deviceId,
            ]
            return (200, try! JSONSerialization.data(withJSONObject: response))
        }
    }

    private func link(_ request: URLRequest, token: String, body: Data) -> (Int, Data) {
        lock.withLock {
            let id = String(request.url!.path.dropFirst("/v1/link-sessions".count).drop { $0 == "/" })
            switch request.httpMethod {
            case "POST":
                let payload = try! JSONSerialization.jsonObject(with: body) as! [String: String]
                guard let userId = accounts[payload["username"]!] else { return (401, Data()) }
                let id = UUID().uuidString
                linkSessions[id] = (userId, nil)
                return (201, try! JSONSerialization.data(withJSONObject: [
                    "id": id, "userId": userId, "expiresAt": Int(Date().timeIntervalSince1970) + 600,
                ]))
            case "PUT":
                guard let session = linkSessions[id] else { return (404, Data()) }
                guard let device = devices[token], device.userId == session.userId,
                      device.isPrimary else { return (403, Data()) }
                linkSessions[id]?.body = body
                return (204, Data())
            default:
                guard let session = linkSessions[id] else { return (404, Data()) }
                return session.body.map { (200, $0) } ?? (204, Data())
            }
        }
    }

    private func deviceList(_ token: String) -> (Int, Data) {
        lock.withLock {
            guard let userId = caller(token) else { return (401, Data()) }
            listFetches[userId, default: 0] += 1
            guard listStatus == 200 else { return (listStatus, Data("device list failed".utf8)) }
            let list = customDevicesResponse ?? owned(userId).map {
                ["deviceId": $0.deviceId, "name": "test", "isPrimary": $0.isPrimary]
            }
            return (200, try! JSONSerialization.data(withJSONObject: ["devices": list]))
        }
    }

    private func bundles(_ userId: String) -> (Int, Data) {
        lock.withLock {
            userFetches[userId, default: 0] += 1
            let owned = owned(userId)
            if owned.isEmpty { return (404, Data()) }
            return (200, try! JSONSerialization.data(withJSONObject: ["bundles": owned.map { $0.consumeBundle() }]))
        }
    }

    private func bundle(_ userId: String, deviceId: String) -> (Int, Data) {
        lock.withLock {
            deviceFetches[deviceId, default: 0] += 1
            guard let device = devices[deviceId], device.userId == userId else { return (404, Data()) }
            return (200, try! JSONSerialization.data(withJSONObject: device.consumeBundle()))
        }
    }

    private func accept(from senderDeviceId: String, _ body: Data) -> (Int, Data) {
        lock.withLock {
            let request = try! Obscura_V1_SendMessageRequest(serializedBytes: body)
            let senderUserId = devices[senderDeviceId]!.userId
            var response = Obscura_V1_SendMessageResponse()
            for recipient in request.recipients {
                let userId = uuidString(recipient.userID)!
                let current = Set(owned(userId).map(\.deviceId)).subtracting([senderDeviceId])
                var valid: [(FakeDevice, Obscura_V1_SendMessageRequest.Submission)] = []
                for submission in recipient.submissions {
                    guard let id = uuidString(submission.deviceID), current.contains(id), let target = devices[id] else {
                        response.invalidDeviceIds.append(submission.deviceID)
                        continue
                    }
                    valid.append((target, submission))
                }
                let targeted = Set(valid.map(\.0.deviceId))
                if targeted != current {
                    var mismatch = Obscura_V1_SendMessageResponse.DeviceMismatch()
                    mismatch.userID = recipient.userID
                    mismatch.missingDeviceIds = current.subtracting(targeted).sorted().map { uuidBytes($0)! }
                    response.deviceMismatches.append(mismatch)
                    continue
                }
                for (target, submission) in valid {
                    target.mailbox.append((senderUserId, senderDeviceId, submission.message))
                }
            }
            return (200, try! response.serializedData())
        }
    }
}

final class FakeServerProtocol: URLProtocol {
    static let onDeviceList = Locked<(@Sendable () -> Void)?>(nil)
    static let onRefresh = Locked<(@Sendable () -> Void)?>(nil)
    static let pendingRefresh = Locked<(@Sendable () -> Void)?>(nil)
    /// Answers `POST /v1/messages` instead of the server when it returns a response; gets the request body.
    static let messageResponse = Locked<(@Sendable (Data) -> (Int, Data)?)?>(nil)

    static func releasePendingRefresh() {
        let release = pendingRefresh.withLock { pending in
            defer { pending = nil }
            return pending
        }
        release?()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        if url.host == FakeObscuraServer.host { return true }
        if url.host == "127.0.0.1", url.scheme?.lowercased() == "http", FakeObscuraServer.active != nil {
            return true
        }
        return false
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let server = FakeObscuraServer.active else { return }
        server.recordRequest()
        if request.url?.path == "/v1/session", request.httpMethod == "DELETE" {
            respond(server.handle(request, body: Data()))
            return
        }
        if server.isOffline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        if request.url?.path == "/v1/devices", request.httpMethod == "GET",
           let held = Self.onDeviceList.withLock({ $0 }) {
            held()
            return
        }
        let body = Self.body(of: request)
        if request.url?.path == "/v1/session/refresh",
           let onRefresh = Self.onRefresh.withLock({ $0 }) {
            Self.pendingRefresh.withLock { $0 = { [self] in respond(server.handle(request, body: body)) } }
            onRefresh()
            return
        }
        let override = request.url?.path == "/v1/messages" ? Self.messageResponse.withLock { $0 }?(body) : nil
        respond(override ?? server.handle(request, body: body))
    }
    override func stopLoading() {}

    private func respond(_ response: (Int, Data)) {
        let (status, data) = response
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// A decrypted delivery. `baseKey` identifies the session a prekey message starts; nil otherwise.
struct Received {
    let message: Obscura_Client_V1_ClientMessage
    let senderDeviceId: String
    let type: Obscura_Client_V1_EncryptedMessage.TypeEnum
    let baseKey: PublicKey?
}

/// A real Signal device: its own store, keys, directory and `MessageSender`, provisioned as its
/// user's primary or as a linked device.
final class FakeDevice: @unchecked Sendable {
    let userId: String
    let deviceId = UUID().uuidString.lowercased()
    let primaryDeviceId: String
    let db: DatabaseQueue
    let store: PersistentSignalStore
    let directory: DeviceStore
    let messenger: Messenger
    let sender: MessageSender
    let logger = RecordingLogger(SilentLogger())
    fileprivate var mailbox: [(senderUserId: String, senderDeviceId: String, message: Data)] = []
    private var unusedPreKeys: [PreKeyRecord] = []
    private var unusedKyberPreKeys: [KyberPreKeyRecord] = []
    private let signedPreKey: SignedPreKeyRecord
    private let lastResortKyberPreKey: KyberPreKeyRecord
    private let corruptBundle: Bool
    private let corruptKyber: Bool

    var isPrimary: Bool { deviceId == primaryDeviceId }

    init(userId: String, primary: FakeDevice?, corruptBundle: Bool, corruptKyber: Bool, rogueIdentity: Bool) async throws {
        self.userId = userId
        self.corruptBundle = corruptBundle
        self.corruptKyber = corruptKyber
        primaryDeviceId = primary?.deviceId ?? deviceId
        db = try ObscuraDatabase.inMemory()
        store = PersistentSignalStore(db: db, logger: logger)
        directory = DeviceStore(db: db)
        let api = try APIClient(baseURL: FakeObscuraServer.baseURL)
        messenger = Messenger(api: api, store: store)
        sender = MessageSender(messenger: messenger, devices: directory, api: api, logger: logger, selfDeviceId: deviceId)
        let identity = try primary.flatMap { rogueIdentity ? nil : try $0.store.identityKeyPair(context: NullContext()) }
            ?? IdentityKeyPair.generate()
        let keys = try PreKeys.generateProvisioningKeys(identity: identity, nowMs: testNowMs())
        unusedPreKeys = keys.oneTimePreKeys
        unusedKyberPreKeys = keys.kyberPreKeys
        signedPreKey = keys.signedPreKey
        lastResortKyberPreKey = keys.lastResortKyberPreKey
        try await db.write { [deviceId, primaryDeviceId] db in
            try PersistentSignalStore.install(keys, in: db)
            try DeviceStore.setLocalDevice(deviceId, primaryDeviceId: primaryDeviceId, in: db)
            try DeviceStore.add(userId: userId, deviceId: deviceId, in: db)
        }
        api.setToken(deviceId)
    }

    var remainingPreKeys: Int { unusedPreKeys.count }

    func forgetSessions() throws {
        try db.write { db in try db.execute(sql: "DELETE FROM signal_sessions") }
    }

    var remainingKyberPreKeys: Int { unusedKyberPreKeys.count }

    /// Serves a one-time Kyber key while any remain, then the last-resort key, as the server does.
    fileprivate func consumeBundle() -> [String: Any] {
        let signed = signedPreKey
        let oneTime: Any = unusedPreKeys.isEmpty ? NSNull() : {
            let key = unusedPreKeys.removeFirst()
            return ["keyId": key.id, "publicKey": Data(try! key.publicKey().serialize()).base64EncodedString()]
        }()
        let kyber = unusedKyberPreKeys.isEmpty ? lastResortKyberPreKey : unusedKyberPreKeys.removeFirst()
        return [
            "deviceId": deviceId,
            "registrationId": try! store.localRegistrationId(context: NullContext()),
            "identityKey": Data(try! store.identityKeyPair(context: NullContext()).publicKey.serialize()).base64EncodedString(),
            "signedPreKey": [
                "keyId": signed.id,
                "publicKey": Data(try! signed.publicKey().serialize()).base64EncodedString(),
                "signature": Data(corruptBundle ? [UInt8](repeating: 0, count: 64) : Array(signed.signature)).base64EncodedString(),
            ],
            "kyberPreKey": [
                "keyId": kyber.id,
                "publicKey": Data(try! kyber.publicKey().serialize()).base64EncodedString(),
                "signature": Data(corruptKyber ? [UInt8](repeating: 0, count: 64) : Array(kyber.signature)).base64EncodedString(),
            ],
            "oneTimePreKey": oneTime,
        ]
    }

    /// Decrypt and clear the mailbox, recording each sender in the directory as the client does.
    func receive() async throws -> [Received] {
        let delivered = FakeObscuraServer.active!.drain(self)
        var received: [Received] = []
        for (senderUserId, senderDeviceId, data) in delivered {
            let encrypted = try Obscura_Client_V1_EncryptedMessage(serializedBytes: data)
            let plaintext = try await messenger.decryptAndPersist(senderUserId: senderUserId, senderDeviceUuid: senderDeviceId,
                                                                  encrypted) { plaintext, _ in plaintext }
            received.append(Received(
                message: try Obscura_Client_V1_ClientMessage(serializedBytes: plaintext),
                senderDeviceId: senderDeviceId,
                type: encrypted.type,
                baseKey: encrypted.type == .prekeyMessage ? try PreKeySignalMessage(bytes: Array(encrypted.content)).baseKey : nil
            ))
        }
        return received
    }

    /// The pending deliveries as gateway envelopes, for an `ObscuraClient` on this device's database.
    func envelopes() -> [Envelope] {
        FakeObscuraServer.active!.drain(self).map {
            Envelope(id: uuidBytes(UUID().uuidString)!, senderUserId: uuidBytes($0.senderUserId)!,
                     senderDeviceId: uuidBytes($0.senderDeviceId)!, message: $0.message)
        }
    }
}

extension FakeObscuraServer {
    func drain(_ device: FakeDevice) -> [(senderUserId: String, senderDeviceId: String, message: Data)] {
        lock.withLock {
            defer { device.mailbox.removeAll() }
            return device.mailbox
        }
    }
}
