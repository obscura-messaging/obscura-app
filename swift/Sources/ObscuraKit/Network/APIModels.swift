import Foundation

struct AuthResponse: Decodable {
    let token: String
    let refreshToken: String
    let expiresAt: Int64
    let userId: String
    let deviceId: String
}

struct SignedPreKeyUpload: Codable, Equatable {
    let keyId: Int
    let publicKey: String
    let signature: String
}

struct PreKeyUpload: Codable, Equatable {
    let keyId: Int
    let publicKey: String
}

typealias KyberPreKeyUpload = SignedPreKeyUpload

/// `POST /v1/keys`. Each part present replaces what the server holds of that kind; absent parts, and
/// empty one-time lists, are left as they are. The identity is the account's and cannot change there.
struct PreKeysUpload: Encodable, Equatable {
    let signedPreKey: SignedPreKeyUpload?
    let lastResortKyberPreKey: KyberPreKeyUpload?
    let oneTimePreKeys: [PreKeyUpload]
    let kyberPreKeys: [KyberPreKeyUpload]

    private enum CodingKeys: String, CodingKey {
        case signedPreKey, lastResortKyberPreKey, oneTimePreKeys, kyberPreKeys
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(signedPreKey, forKey: .signedPreKey)
        try container.encodeIfPresent(lastResortKyberPreKey, forKey: .lastResortKyberPreKey)
        if !oneTimePreKeys.isEmpty { try container.encode(oneTimePreKeys, forKey: .oneTimePreKeys) }
        if !kyberPreKeys.isEmpty { try container.encode(kyberPreKeys, forKey: .kyberPreKeys) }
    }
}

/// `GET /v1/keys`: how many one-time pre-keys of each kind the server still holds for this device.
struct PreKeyCounts: Decodable, Equatable, Sendable {
    let oneTime: Int
    let kyber: Int

    init(oneTime: Int, kyber: Int) {
        self.oneTime = oneTime
        self.kyber = kyber
    }

    private enum CodingKeys: String, CodingKey {
        case oneTime = "oneTimePreKeyCount", kyber = "kyberPreKeyCount"
    }
}

/// `POST /v1/users` and `POST /v1/users/reset`.
struct AccountProvisionRequest: Encodable {
    let username: String
    let password: String
    let name: String
    let identityKey: String
    let registrationId: Int
    let signedPreKey: SignedPreKeyUpload
    let lastResortKyberPreKey: KyberPreKeyUpload
    let oneTimePreKeys: [PreKeyUpload]
    let kyberPreKeys: [KyberPreKeyUpload]
}

/// `POST /v1/devices`.
struct CreateDeviceRequest: Encodable {
    let linkSessionId: String
    let name: String
    let identityKey: String
    let registrationId: Int
    let signedPreKey: SignedPreKeyUpload
    let lastResortKyberPreKey: KyberPreKeyUpload
    let oneTimePreKeys: [PreKeyUpload]
    let kyberPreKeys: [KyberPreKeyUpload]
}

struct DeviceResponse: Decodable {
    let deviceId: String
    let name: String?
    let isPrimary: Bool
}

struct LinkSessionResponse: Decodable {
    let id: String
    let userId: String
    let expiresAt: Int64
}

struct PreKeyBundleResponse: Decodable {
    let deviceId: String
    let registrationId: Int
    let identityKey: String
    let signedPreKey: SignedPreKeyData
    /// A one-time Kyber key while the device has any, otherwise its last-resort key.
    let kyberPreKey: SignedPreKeyData
    let oneTimePreKey: PreKeyData?

    struct SignedPreKeyData: Decodable {
        let keyId: Int
        let publicKey: String
        let signature: String
    }

    struct PreKeyData: Decodable {
        let keyId: Int
        let publicKey: String
    }
}

struct AttachmentResponse: Decodable {
    let id: String
}

struct GatewayTicketResponse: Decodable {
    let ticket: String
}
