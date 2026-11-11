import Foundation
import XCTest
import SwiftProtobuf
@testable import ObscuraKit

/// Vector-driven client-wire conformance, consuming the shared
/// `../client-protocol/conformance/wire.json`. Both platforms run the
/// same file.
///
/// Pins the signal enum <-> app-facing-form mapping via the production
/// `WireCodec`, and that a `AppEntry` round-trips through the wire by VALUE.
/// Byte-canonicity is intentionally NOT asserted.
///
/// The `wire`-name → generated-enum-case maps below are a test harness:
/// SwiftProtobuf does not expose the proto enum names, so we bind them once here.
/// The production mapping under test is `WireCodec`.
final class WireConformanceTests: XCTestCase {

    private let payloadByWire: [String: Obscura_Client_V1_ClientMessage.OneOf_Payload] = [
        "friend_request": .friendRequest(Obscura_Client_V1_FriendRequest()),
        "friend_accept": .friendAccept(Obscura_Client_V1_FriendAccept()),
        "typing_signal": .typingSignal(Obscura_Client_V1_TypingSignal()),
        "friend_list_sync": .friendListSync(Obscura_Client_V1_FriendListSync()),
        "direct_message": .directMessage(Obscura_Client_V1_DirectMessage()),
        "pix": .pix(Obscura_Client_V1_PixMessage()),
        "seen_receipt": .seenReceipt(Obscura_Client_V1_SeenReceipt()),
        "story": .story(Obscura_Client_V1_StoryPost()),
        "profile": .profile(Obscura_Client_V1_ProfileUpdate()),
    ]
    private let typingStateByWire: [String: Obscura_Client_V1_TypingState] = [
        "TYPING_STATE_STARTED": .started,
        "TYPING_STATE_STOPPED": .stopped,
    ]

    func testWireConformance() throws {
        let v = try ConformanceVectors.load("wire.json")

        for m in (v["messageTypes"] as? [[String: Any]] ?? []) {
            let wire = m["wire"] as? String ?? "", app = m["app"] as? String ?? ""
            guard let p = payloadByWire[wire] else { XCTFail("unmapped wire messageType \(wire)"); continue }
            XCTAssertEqual(WireCodec.messageKind(p), app, "messageType \(wire) -> \(app)")
        }

        for m in (v["typingStates"] as? [[String: Any]] ?? []) {
            let wire = m["wire"] as? String ?? "", app = m["app"] as? String ?? ""
            guard let wireState = typingStateByWire[wire],
                  let appState = TypingState(rawValue: app)
            else {
                XCTFail("unmapped typing state \(wire)/\(app)")
                continue
            }
            XCTAssertEqual(WireCodec.decodeTypingState(wireState), appState, "decode \(wire)")
            XCTAssertEqual(WireCodec.encodeTypingState(appState), wireState, "encode \(app)")
        }

        for m in (v["mediaTypes"] as? [[String: Any]] ?? []) {
            let wire = m["wire"] as? String ?? "", app = m["app"] as? String ?? ""
            let decoded = MediaType(wire: wire)
            XCTAssertEqual(decoded.rawValue, app, "decode \"\(wire)\"")
            if wire == app { XCTAssertEqual(decoded.rawValue, wire, "encode \(app)") }
        }

        for m in (v["conversationKinds"] as? [[String: Any]] ?? []) {
            let wire = m["wire"] as? String ?? "", app = m["app"] as? String ?? ""
            XCTAssertEqual(ConversationKind(rawValue: wire)?.rawValue, app, "decode \(wire)")
            XCTAssertEqual(ConversationKind(rawValue: app)?.rawValue, wire, "encode \(app)")
        }

        for rt in (v["roundTrip"] as? [[String: Any]] ?? []) {
            let name = rt["name"] as? String ?? "?"
            if let dm = rt["directMessage"] as? [String: Any] {
                try roundTripDirectMessage(dm, name: name)
            } else if let pix = rt["pix"] as? [String: Any] {
                try roundTripPix(pix, name: name)
            } else {
                XCTFail("unknown roundTrip case \(name)")
            }
        }
    }

    private func roundTripDirectMessage(_ dm: [String: Any], name: String) throws {
        let id = dm["id"] as? String ?? ""
        let peerUserId = dm["peerUserId"] as? String ?? ""
        let content = dm["content"] as? String ?? ""
        let ts = conformanceUInt64(dm["timestamp"])

        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = ts
        message.directMessage.id = id
        message.directMessage.peerUserID = peerUserId
        message.directMessage.content = content

        let decoded = try Obscura_Client_V1_ClientMessage(serializedBytes: message.serializedData())
        XCTAssertEqual(decoded.timestamp, ts, "[\(name)] timestamp")
        XCTAssertEqual(decoded.directMessage.id, id, "[\(name)] id")
        XCTAssertEqual(decoded.directMessage.peerUserID, peerUserId, "[\(name)] peerUserId")
        XCTAssertEqual(decoded.directMessage.content, content, "[\(name)] content")
    }

    private func roundTripPix(_ px: [String: Any], name: String) throws {
        let id = px["id"] as? String ?? ""
        let peerUserId = px["peerUserId"] as? String ?? ""
        let attachmentId = px["attachmentId"] as? String ?? ""
        let contentKeyHex = px["contentKey"] as? String ?? ""
        let nonceHex = px["nonce"] as? String ?? ""
        let mediaType = px["mediaType"] as? String ?? ""
        let caption = px["caption"] as? String ?? ""
        let captionMeta = px["captionMeta"] as? String ?? ""
        let duration = UInt32(conformanceUInt64(px["displayDurationSecs"]))
        let ts = conformanceUInt64(px["timestamp"])

        let contentKey = try hexBytes(contentKeyHex)
        let nonce = try hexBytes(nonceHex)

        var message = Obscura_Client_V1_ClientMessage()
        message.timestamp = ts
        message.pix.id = id
        message.pix.peerUserID = peerUserId
        message.pix.attachment.id = attachmentId
        message.pix.attachment.contentKey = contentKey
        message.pix.attachment.nonce = nonce
        message.pix.attachment.mediaType = mediaType
        message.pix.caption = caption
        message.pix.captionMeta = captionMeta
        message.pix.displayDurationSecs = duration

        let decoded = try Obscura_Client_V1_ClientMessage(serializedBytes: message.serializedData())
        XCTAssertEqual(decoded.timestamp, ts, "[\(name)] timestamp")
        XCTAssertEqual(decoded.pix.id, id, "[\(name)] id")
        XCTAssertEqual(decoded.pix.peerUserID, peerUserId, "[\(name)] peerUserId")
        XCTAssertEqual(decoded.pix.attachment.id, attachmentId, "[\(name)] attachmentId")
        XCTAssertEqual(decoded.pix.attachment.contentKey, contentKey, "[\(name)] contentKey")
        XCTAssertEqual(decoded.pix.attachment.nonce, nonce, "[\(name)] nonce")
        XCTAssertEqual(decoded.pix.attachment.mediaType, mediaType, "[\(name)] mediaType")
        XCTAssertEqual(decoded.pix.caption, caption, "[\(name)] caption")
        XCTAssertEqual(decoded.pix.captionMeta, captionMeta, "[\(name)] captionMeta")
        XCTAssertEqual(decoded.pix.displayDurationSecs, duration, "[\(name)] displayDurationSecs")
    }

    private func hexBytes(_ hex: String) throws -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            let byte = try XCTUnwrap(UInt8(hex[index..<next], radix: 16))
            data.append(byte)
            index = next
        }
        return data
    }
}
