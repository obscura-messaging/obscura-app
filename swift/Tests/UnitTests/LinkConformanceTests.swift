import Foundation
import LibSignalClient
import XCTest
@testable import ObscuraKit

/// Vector-driven device-link conformance, consuming the shared `../protocol/conformance/link.json`.
/// Both platforms run the same file; every check the conformance README lists for it is asserted.
final class LinkConformanceTests: XCTestCase {
    private let statusByWire: [String: Obscura_Client_V1_FriendStatus] = [
        "FRIEND_STATUS_PENDING_SENT": .pendingSent,
        "FRIEND_STATUS_PENDING_RECEIVED": .pendingReceived,
        "FRIEND_STATUS_ACCEPTED": .accepted,
    ]

    func testEnvelopes() throws {
        let vectors = try ConformanceVectors.load("link.json")
        let envelopes = try XCTUnwrap(vectors["envelopes"] as? [[String: Any]])
        XCTAssertFalse(envelopes.isEmpty)
        for vector in envelopes {
            let name = vector["name"] as? String ?? "?"
            let newDevicePrivate = try PrivateKey(hex(vector, "newDevicePrivateKey"))
            let primaryPrivate = try PrivateKey(hex(vector, "primaryPrivateKey"))
            let newDevicePublic = try PublicKey(hex(vector, "newDevicePublicKey"))
            let primaryPublic = try PublicKey(hex(vector, "primaryPublicKey"))
            let key = try hex(vector, "key")
            let nonce = try hex(vector, "nonce")
            let plaintext = try hex(vector, "plaintext")
            let ciphertext = try hex(vector, "ciphertext")

            XCTAssertEqual(newDevicePrivate.publicKey.serialize(), newDevicePublic.serialize(), name)
            XCTAssertEqual(primaryPrivate.publicKey.serialize(), primaryPublic.serialize(), name)
            XCTAssertEqual(Data(newDevicePrivate.keyAgreement(with: primaryPublic)), try hex(vector, "sharedSecret"), name)
            XCTAssertEqual(Data(primaryPrivate.keyAgreement(with: newDevicePublic)), try hex(vector, "sharedSecret"), name)
            XCTAssertEqual(LinkCrypto.key(privateKey: primaryPrivate, peerPublicKey: newDevicePublic), key, name)
            XCTAssertEqual(LinkCrypto.key(privateKey: newDevicePrivate, peerPublicKey: primaryPublic), key, name)

            let sealed = try LinkCrypto.seal(plaintext, to: newDevicePublic, ephemeral: primaryPrivate, nonce: nonce)
            XCTAssertEqual(sealed.ciphertext, ciphertext, name)
            XCTAssertEqual(sealed.ephemeralPublicKey, Data(primaryPublic.serialize()), name)
            XCTAssertEqual(sealed.nonce, nonce, name)
            XCTAssertEqual(try LinkCrypto.open(sealed, with: newDevicePrivate), plaintext, name)

            let envelope = try Obscura_Client_V1_LinkEnvelope(serializedBytes: hex(vector, "linkEnvelope"))
            XCTAssertEqual(envelope.ephemeralPublicKey, Data(primaryPublic.serialize()), name)
            XCTAssertEqual(envelope.nonce, nonce, name)
            XCTAssertEqual(envelope.ciphertext, ciphertext, name)
            XCTAssertEqual(try Obscura_Client_V1_LinkEnvelope(serializedBytes: sealed.serializedData()), envelope, name)

            try checkBundle(plaintext, try XCTUnwrap(vector["linkBundle"] as? [String: Any]), name: name)
        }
    }

    private func checkBundle(_ plaintext: Data, _ expected: [String: Any], name: String) throws {
        let bundle = try Obscura_Client_V1_LinkBundle(serializedBytes: plaintext)
        let identityKeyPair = try hex(expected, "identityKeyPair")
        XCTAssertEqual(bundle.identityKeyPair, identityKeyPair, name)
        let pair = try IdentityKeyPair(bytes: identityKeyPair)
        XCTAssertEqual(Data(pair.privateKey.serialize()), try hex(expected, "identityPrivateKey"), name)
        XCTAssertEqual(Data(pair.publicKey.serialize()), try hex(expected, "identityPublicKey"), name)
        let rebuilt = IdentityKeyPair(publicKey: try PublicKey(hex(expected, "identityPublicKey")),
                                      privateKey: try PrivateKey(hex(expected, "identityPrivateKey")))
        XCTAssertEqual(Data(rebuilt.serialize()), identityKeyPair, name)
        XCTAssertEqual(bundle.userID, expected["userId"] as? String, name)
        XCTAssertEqual(bundle.username, expected["username"] as? String, name)
        XCTAssertEqual(bundle.primaryDeviceID, expected["primaryDeviceId"] as? String, name)
        XCTAssertEqual(bundle.friendListVersion, conformanceUInt64(expected["friendListVersion"]), name)
        let friends = try XCTUnwrap(expected["friends"] as? [[String: Any]])
        XCTAssertEqual(bundle.friends.map(\.userID), friends.map { $0["userId"] as? String ?? "" }, name)
        XCTAssertEqual(bundle.friends.map(\.username), friends.map { $0["username"] as? String ?? "" }, name)
        XCTAssertEqual(bundle.friends.map(\.status), friends.map { statusByWire[$0["status"] as? String ?? ""] ?? .unspecified }, name)
        XCTAssertNoThrow(try WireCodec.friends(bundle.friends), name)
        if let history = expected["history"] as? [String: Any] {
            XCTAssertTrue(bundle.hasHistory, name)
            XCTAssertEqual(bundle.history.attachmentID, history["attachmentId"] as? String, name)
            XCTAssertEqual(bundle.history.contentKey, try hex(history, "contentKey"), name)
            XCTAssertEqual(bundle.history.nonce, try hex(history, "nonce"), name)
        } else {
            XCTAssertFalse(bundle.hasHistory, name)
        }
    }

    func testLinkCodes() throws {
        let vectors = try ConformanceVectors.load("link.json")
        let codes = try XCTUnwrap(vectors["linkCodes"] as? [[String: Any]])
        XCTAssertFalse(codes.isEmpty)
        for vector in codes {
            let name = vector["name"] as? String ?? "?"
            var fields = Obscura_Client_V1_LinkCode()
            fields.sessionID = try XCTUnwrap(vector["sessionId"] as? String)
            fields.ephemeralPublicKey = try hex(vector, "ephemeralPublicKey")
            fields.deviceName = try XCTUnwrap(vector["deviceName"] as? String)

            XCTAssertEqual(try LinkCrypto.decode(try XCTUnwrap(vector["code"] as? String)), fields, name)
            XCTAssertEqual(try ObscuraClient.linkCodeDeviceName(try XCTUnwrap(vector["code"] as? String)),
                           fields.deviceName, name)
            XCTAssertEqual(try LinkCrypto.decode(LinkCrypto.encode(fields)), fields, name)
            XCTAssertFalse(try LinkCrypto.encode(fields).contains { "+/=".contains($0) }, name)
        }
    }

    func testAMalformedCodeHasNoDeviceName() {
        for code in ["", "not base64!", "AAAA", "CiBacTN2WDltVDJwTDhzUjR3SzduQjFjWTZoSjBkRjVnQRIhBbGz8h9-ZjC0Epfni2lrc0xex1WnDesXsVLueIf58qQrGg5BbGljZSdzIGlQaG9uZQ=="] {
            XCTAssertThrowsError(try ObscuraClient.linkCodeDeviceName(code), code) {
                XCTAssertEqual($0 as? ObscuraError, .invalidArgument("link code"))
            }
        }
    }

    private func hex(_ object: [String: Any], _ key: String) throws -> Data {
        let string = try XCTUnwrap(object[key] as? String, "missing \(key)")
        var data = Data()
        var index = string.startIndex
        while index < string.endIndex {
            let next = string.index(index, offsetBy: 2)
            data.append(try XCTUnwrap(UInt8(string[index..<next], radix: 16), "bad hex in \(key)"))
            index = next
        }
        return data
    }
}
