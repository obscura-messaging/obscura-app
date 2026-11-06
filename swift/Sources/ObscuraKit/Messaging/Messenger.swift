import Foundation
import GRDB
import LibSignalClient
import SwiftProtobuf

/// Signal sessions, encryption and submission for single devices. Which devices to address is
/// `MessageSender`'s job.
actor Messenger {
    private let api: APIClient
    private let store: PersistentSignalStore

    init(api: APIClient, store: PersistentSignalStore) {
        self.api = api
        self.store = store
    }

    /// libsignal's device-id slot. The device UUID identifies the peer, so the slot is a constant.
    static let deviceSlot: UInt32 = 1

    /// Send and receive must build the same address for a device, or its session splits in two.
    static func address(_ deviceUuid: String) throws -> ProtocolAddress {
        try ProtocolAddress(name: deviceUuid, deviceId: deviceSlot)
    }

    func hasSession(_ deviceUuid: String) throws -> Bool {
        try store.loadSession(for: Self.address(deviceUuid), context: NullContext())?.hasCurrentState ?? false
    }

    /// Parses one fetch of a user's bundles. Every bundle must carry the same identity key and a signed
    /// prekey that verifies against it, or the whole fetch is refused.
    static func verifiedBundles(_ responses: [PreKeyBundleResponse]) throws -> [(deviceId: String, bundle: PreKeyBundle)] {
        for response in responses {
            guard UUID(uuidString: response.deviceId) != nil else {
                throw ObscuraError.protocolViolation("invalid deviceId in bundle: \(response.deviceId)")
            }
        }
        guard Set(responses.map(\.deviceId)).count == responses.count else {
            throw ObscuraError.protocolViolation("duplicate deviceId in bundle response")
        }
        let parsed = try responses.map { ($0.deviceId, try bundle($0)) }
        let identities = Set(parsed.map { Data($0.1.identityKey.serialize()) })
        guard identities.count <= 1 else {
            throw ObscuraError.protocolViolation("bundles carry \(identities.count) different identity keys")
        }
        for (deviceId, bundle) in parsed {
            guard try bundle.identityKey.publicKey.verifySignature(message: bundle.signedPreKeyPublic.serialize(),
                                                                   signature: bundle.signedPreKeySignature) else {
                throw ObscuraError.protocolViolation("signed prekey of device \(deviceId) does not verify")
            }
        }
        return parsed
    }

    private static func bundle(_ response: PreKeyBundleResponse) throws -> PreKeyBundle {
        guard let identityKey = Data(base64Encoded: response.identityKey),
              let signedPreKey = Data(base64Encoded: response.signedPreKey.publicKey),
              let signature = Data(base64Encoded: response.signedPreKey.signature) else {
            throw ObscuraError.protocolViolation("invalid base64 in bundle for \(response.deviceId)")
        }
        let identity = try IdentityKey(bytes: identityKey)
        let signedPublic = try PublicKey(signedPreKey)
        let registrationId = UInt32(response.registrationId)
        let signedPreKeyId = UInt32(response.signedPreKey.keyId)
        guard let oneTime = response.oneTimePreKey else {
            return try PreKeyBundle(
                registrationId: registrationId, deviceId: deviceSlot,
                signedPrekeyId: signedPreKeyId, signedPrekey: signedPublic, signedPrekeySignature: signature, identity: identity)
        }
        guard let oneTimeKey = Data(base64Encoded: oneTime.publicKey) else {
            throw ObscuraError.protocolViolation("invalid one-time prekey for \(response.deviceId)")
        }
        return try PreKeyBundle(
            registrationId: registrationId, deviceId: deviceSlot, prekeyId: UInt32(oneTime.keyId), prekey: PublicKey(oneTimeKey),
            signedPrekeyId: signedPreKeyId, signedPrekey: signedPublic, signedPrekeySignature: signature, identity: identity)
    }

    /// Verifies one fetch of `userId`'s bundles, lists their devices in the directory (identity trust
    /// resolves through it), and builds a session for each device that has none. A refused fetch stores
    /// nothing. Processing a bundle over an established session would restart the ratchet, so an
    /// existing session always wins.
    func establishSessions(userId: String, _ responses: [PreKeyBundleResponse]) throws {
        let bundles = try Self.verifiedBundles(responses)
        for (deviceId, bundle) in bundles {
            try store.transaction { database, _ in
                try DeviceStore.add(userId: userId, deviceId: deviceId, in: database)
            }
            if try !hasSession(deviceId) {
                try processPreKeyBundle(bundle, for: Self.address(deviceId), sessionStore: store, identityStore: store,
                                        context: NullContext())
            }
        }
    }

    /// Encrypts for one device with its existing session.
    func prepareSubmission(deviceId: String, clientMessage: Data) throws -> Obscura_V1_SendMessageRequest.Submission {
        guard let deviceBytes = uuidBytes(deviceId) else {
            throw ObscuraError.protocolViolation("device id \(deviceId) is not a UUID")
        }
        let ciphertext = try signalEncrypt(message: clientMessage, for: Self.address(deviceId),
                                           sessionStore: store, identityStore: store, context: NullContext())
        var encrypted = Obscura_Client_V1_EncryptedMessage()
        encrypted.type = ciphertext.messageType == .preKey ? .prekeyMessage : .encryptedMessage
        encrypted.content = Data(ciphertext.serialize())

        var submission = Obscura_V1_SendMessageRequest.Submission()
        submission.deviceID = deviceBytes
        submission.message = try encrypted.serializedData()
        return submission
    }

    /// Uploads `submissions` to `userIds`' devices as one batched request. Pre-processing HTTP rejections are
    /// definitive; transport, server or decoding failures leave acceptance unknown.
    /// The request names `userIds`, so each is checked for complete delivery even without submissions.
    func submit(userIds: [String], submissions: [UserSubmission]) async -> SubmitOutcome {
        let byUser = Dictionary(grouping: submissions, by: \.userId)
        var recipients: [Obscura_V1_SendMessageRequest.Recipient] = []
        var seen: Set<String> = []
        for userId in userIds where seen.insert(userId).inserted {
            guard let user = uuidBytes(userId) else {
                return SubmitOutcome(submitted: submissions.map {
                    Submitted(SubmissionResult(userId: $0.userId, deviceId: uuidString($0.submission.deviceID),
                                               status: .rejected, error: "user id \(userId) is not a UUID"))
                })
            }
            var recipient = Obscura_V1_SendMessageRequest.Recipient()
            recipient.userID = user
            recipient.submissions = byUser[userId]?.map(\.submission) ?? []
            recipients.append(recipient)
        }
        var request = Obscura_V1_SendMessageRequest()
        request.recipients = recipients
        do {
            let response = try Obscura_V1_SendMessageResponse(serializedBytes: try await api.sendMessage(request.serializedData()))
            return try submitOutcome(userIds: userIds, submissions: submissions, response: response)
        } catch {
            let status: SubmissionStatus
            if let failure = error as? ObscuraError, case .http(let code, _) = failure,
               [400, 413].contains(code) {
                status = .rejected
            } else {
                status = .unknown
            }
            return SubmitOutcome(submitted: submissions.map {
                Submitted(SubmissionResult(userId: $0.userId, deviceId: uuidString($0.submission.deviceID),
                                           status: status, error: "\(error)"))
            })
        }
    }

    func submit(userId: String, submissions: [Obscura_V1_SendMessageRequest.Submission]) async -> SubmitOutcome {
        await submit(userIds: [userId], submissions: submissions.map { UserSubmission(userId: userId, submission: $0) })
    }

    /// Records the server-stamped sender device in the directory, decrypts, and persists, in one
    /// transaction: identity trust resolves the device to its user, and a failed decrypt rolls the
    /// directory write back. A valid MAC proves the sender holds this device's session, so the stamped
    /// pair is a sound attribution once decrypt succeeds.
    func decryptAndPersist<T: Sendable>(senderUserId: String, senderDeviceUuid: String,
                                       _ encrypted: Obscura_Client_V1_EncryptedMessage,
                                       persist: @Sendable (Data, Database) throws -> T) throws -> T {
        try store.transaction { database, context in
            try DeviceStore.add(userId: senderUserId, deviceId: senderDeviceUuid, in: database)
            let plaintext = try decrypt(senderDeviceUuid: senderDeviceUuid, encrypted, context: context)
            return try persist(plaintext, database)
        }
    }

    func decrypt(senderDeviceUuid: String, _ encrypted: Obscura_Client_V1_EncryptedMessage,
                 context: StoreContext = NullContext()) throws -> Data {
        let address = try Self.address(senderDeviceUuid)
        switch encrypted.type {
        case .prekeyMessage:
            return Data(try signalDecryptPreKey(
                message: PreKeySignalMessage(bytes: encrypted.content), from: address,
                sessionStore: store, identityStore: store, preKeyStore: store, signedPreKeyStore: store,
                kyberPreKeyStore: store, context: context))
        case .encryptedMessage:
            return Data(try signalDecrypt(message: SignalMessage(bytes: encrypted.content), from: address,
                                          sessionStore: store, identityStore: store, context: context))
        case .unspecified, .UNRECOGNIZED:
            throw ObscuraError.protocolViolation("encrypted message type \(encrypted.type.rawValue)")
        }
    }
}
