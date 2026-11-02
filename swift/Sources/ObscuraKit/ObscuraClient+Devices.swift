import Foundation
import LibSignalClient

/// A link in progress on the new device. The app shows `code` as a QR code for the primary to scan.
/// The ephemeral private key lives only in this value.
public struct LinkRequest: Sendable {
    public let code: String
    let sessionId: String
    let expiresAt: Int64
    let username: String
    let userId: String
    let deviceName: String
    let privateKey: Data
}

public struct DeviceInfo: Sendable, Equatable {
    public let deviceId: String
    public let name: String?
    public let isPrimary: Bool
    public let isThisDevice: Bool
}

/// What a decrypted `LinkBundle` gives the new device.
struct LinkContents {
    let identity: IdentityKeyPair
    let primaryDeviceId: String
    let friends: [(userId: String, username: String, status: FriendStatus)]
    let friendListVersion: UInt64
    let history: Obscura_Client_V1_HistorySnapshot?
}

extension ObscuraClient {
    static let linkPollNanoseconds: UInt64 = 250_000_000

    // MARK: - Linking, new device

    /// For `.linkRequired`: opens a link session for this device to show to the primary.
    public func beginLink(_ username: String, _ password: String, deviceName: String) async throws -> LinkRequest {
        guard !deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ObscuraError.invalidArgument("deviceName must not be blank")
        }
        try await requireUnprovisionedDevice()
        let session = try await takeOrCreateLinkSession(username, password)
        let privateKey = PrivateKey.generate()
        var code = Obscura_Client_V1_LinkCode()
        code.sessionID = session.id
        code.ephemeralPublicKey = Data(privateKey.publicKey.serialize())
        code.deviceName = deviceName
        return LinkRequest(code: try LinkCrypto.encode(code), sessionId: session.id, expiresAt: session.expiresAt,
                           username: username, userId: session.userId, deviceName: deviceName,
                           privateKey: Data(privateKey.serialize()))
    }

    private func takeOrCreateLinkSession(_ username: String, _ password: String) async throws -> LinkSessionResponse {
        let cached = pendingLinkSession
        pendingLinkSession = nil
        if let cached, cached.username == username, cached.password == password,
           TimeInterval(cached.session.expiresAt) > Date().timeIntervalSince1970 + 30 {
            return cached.session
        }
        return try await api.createLinkSession(username, password)
    }

    /// Waits for the primary's approval, then provisions this device with the account identity, its
    /// friend list and its history, and connects. Nothing is stored unless the server accepts the device.
    public func completeLink(_ request: LinkRequest) async throws {
        try await requireUnprovisionedDevice()
        let contents = try Self.open(try await awaitApproval(request), privateKey: request.privateKey, userId: request.userId)
        let keys = try SignalKeys.generate(identity: contents.identity)
        let response = try await api.createDevice(keys.deviceRequest(name: request.deviceName, linkSessionId: request.sessionId))
        let session = try session(response, username: request.username)
        try await db.write { db in
            try PersistentSignalStore.install(keys, in: db)
            try DeviceStore.setLocalDevice(session.deviceId, primaryDeviceId: contents.primaryDeviceId, in: db)
            try DeviceStore.add(userId: session.userId, deviceId: session.deviceId, in: db)
            try FriendStore.replace(contents.friends, version: contents.friendListVersion, in: db)
        }
        try begin(session, publishAuth: false)
        defer { if self.session != nil { auth.set(.authenticated) } }
        if let history = contents.history {
            let snapshot = try await downloadDecryptedAttachment(id: history.attachmentID, contentKey: history.contentKey,
                                                                 nonce: history.nonce)
            let parsed: Obscura_Client_V1_EntrySnapshot
            do {
                parsed = try Obscura_Client_V1_EntrySnapshot(serializedBytes: snapshot)
            } catch {
                throw ObscuraError.protocolViolation("invalid history snapshot")
            }
            try await entries.importSnapshot(parsed)
        }
        try await connect()
    }

    private func awaitApproval(_ request: LinkRequest) async throws -> Data {
        while Date().timeIntervalSince1970 < TimeInterval(request.expiresAt) {
            try Task.checkCancellation()
            do {
                if let body = try await api.awaitLinkSession(request.sessionId) {
                    return body
                }
            } catch ObscuraError.http(status: 404, body: _) {
                throw ObscuraError.linkFailed("link session expired or unknown")
            }
            guard Date().timeIntervalSince1970 < TimeInterval(request.expiresAt) else { break }
            try await Task.sleep(nanoseconds: Self.linkPollNanoseconds)
        }
        throw ObscuraError.linkFailed("link session expired")
    }

    /// Decrypts and checks the primary's `LinkEnvelope`: `LINK_FAILED` if it does not decrypt,
    /// `PROTOCOL_VIOLATION` if what decrypts is malformed or names another account.
    static func open(_ body: Data, privateKey: Data, userId: String) throws -> LinkContents {
        let envelope: Obscura_Client_V1_LinkEnvelope
        do {
            envelope = try Obscura_Client_V1_LinkEnvelope(serializedBytes: body)
        } catch {
            throw ObscuraError.linkFailed("envelope does not parse: \(error)")
        }
        let plaintext = try LinkCrypto.open(envelope, with: try PrivateKey(privateKey))
        do {
            let bundle = try Obscura_Client_V1_LinkBundle(serializedBytes: plaintext)
            guard bundle.userID == userId else { throw ObscuraError.protocolViolation("link bundle is for user \(bundle.userID)") }
            guard UUID(uuidString: bundle.primaryDeviceID) != nil else {
                throw ObscuraError.protocolViolation("invalid primary device id in link bundle")
            }
            return LinkContents(identity: try IdentityKeyPair(bytes: bundle.identityKeyPair),
                                primaryDeviceId: bundle.primaryDeviceID,
                                friends: try WireCodec.friends(bundle.friends),
                                friendListVersion: bundle.friendListVersion,
                                history: bundle.hasHistory ? bundle.history : nil)
        } catch let error as ObscuraError {
            throw error
        } catch {
            throw ObscuraError.protocolViolation("malformed link bundle: \(error)")
        }
    }

    // MARK: - Linking, primary

    /// The name the new device gave itself, for the app to show before `approveLink`.
    public static func linkCodeDeviceName(_ code: String) throws -> String {
        try LinkCrypto.decode(code).deviceName
    }

    /// Primary only. Sends the account identity, friend list and history to the device showing `code`.
    public func approveLink(_ code: String) async throws {
        let session = try await requireFreshSession()
        try await requirePrimary()
        let linkCode = try LinkCrypto.decode(code)
        var bundle = Obscura_Client_V1_LinkBundle()
        bundle.identityKeyPair = Data(try signalStore.identityKeyPair(context: NullContext()).serialize())
        bundle.userID = session.userId
        bundle.username = session.username
        bundle.primaryDeviceID = session.deviceId
        let friendList = try await friends.listSync()
        bundle.friendListVersion = friendList.version
        bundle.friends = friendList.friends
        let snapshot = try await entries.snapshot()
        if !snapshot.entries.isEmpty {
            let uploaded = try await uploadAttachment(snapshot.serializedData())
            bundle.history.attachmentID = uploaded.id
            bundle.history.contentKey = uploaded.contentKey
            bundle.history.nonce = uploaded.nonce
        }
        let envelope = try LinkCrypto.seal(bundle.serializedData(), to: PublicKey(linkCode.ephemeralPublicKey))
        do {
            try await api.approveLinkSession(linkCode.sessionID, envelope: envelope.serializedData())
        } catch ObscuraError.http(status: 404, body: _) {
            throw ObscuraError.linkFailed("link session expired or unknown")
        }
    }

    // MARK: - Own devices

    public func devices() async throws -> [DeviceInfo] {
        let session = try await requireFreshSession()
        let generation = sessionGeneration
        let list = try await api.listDevices()
        guard generation == sessionGeneration else { throw CancellationError() }
        guard list.filter(\.isPrimary).count == 1 else {
            throw ObscuraError.protocolViolation("the account has no primary device")
        }
        return list.map {
            DeviceInfo(deviceId: $0.deviceId, name: $0.name, isPrimary: $0.isPrimary, isThisDevice: $0.deviceId == session.deviceId)
        }
    }

    /// On the primary, deletes another device. On a linked device, deletes only this device, then wipes
    /// local data and signs out. The primary cannot be unlinked; reset the account instead.
    public func unlinkDevice(_ deviceId: String) async throws {
        let session = try await requireFreshSession()
        if try await directory.isPrimary() {
            guard deviceId != session.deviceId else {
                throw ObscuraError.invalidArgument("the primary device cannot be unlinked; reset the account instead")
            }
            try await api.deleteDevice(deviceId)
            try await directory.remove(userId: session.userId, deviceIds: [deviceId])
        } else {
            guard deviceId == session.deviceId else { throw ObscuraError.notPrimary }
            try await api.deleteDevice(deviceId)
            try await signOut(revoking: false)
            try await ObscuraDatabase.wipe(db)
        }
    }
}
