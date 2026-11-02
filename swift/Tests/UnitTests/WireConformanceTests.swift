import Foundation
import XCTest
import SwiftProtobuf
@testable import ObscuraKit

/// Vector-driven client-wire conformance, consuming the shared
/// `../protocol/conformance/wire.json`. Both platforms run the
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
        "app_entry": .appEntry(Obscura_Client_V1_AppEntry()),
        "typing_signal": .typingSignal(Obscura_Client_V1_TypingSignal()),
        "friend_list_sync": .friendListSync(Obscura_Client_V1_FriendListSync()),
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

        for rt in (v["roundTrip"] as? [[String: Any]] ?? []) {
            try roundTrip(rt["appEntry"] as? [String: Any] ?? [:], name: rt["name"] as? String ?? "?")
        }
    }

    /// Serialize to protobuf bytes and parse back — a true wire round-trip.
    private func roundTrip(_ ms: [String: Any], name: String) throws {
        let model = ms["model"] as? String ?? ""
        let id = ms["id"] as? String ?? ""
        let ts = conformanceUInt64(ms["timestamp"])
        let dataMap = ms["data"] as? [String: Any] ?? [:]

        var proto = Obscura_Client_V1_AppEntry()
        proto.model = model
        proto.id = id
        proto.timestamp = ts
        proto.data = try JSONSerialization.data(withJSONObject: dataMap)

        let decoded = try Obscura_Client_V1_AppEntry(serializedBytes: proto.serializedData())

        XCTAssertEqual(decoded.model, model, "[\(name)] model")
        XCTAssertEqual(decoded.id, id, "[\(name)] id")
        XCTAssertEqual(decoded.timestamp, ts, "[\(name)] timestamp")
        // data round-trips by VALUE (parsed map), not bytes — key order is irrelevant.
        let decodedData = (try JSONSerialization.jsonObject(with: decoded.data) as? [String: Any]) ?? [:]
        XCTAssertEqual(
            NSDictionary(dictionary: decodedData),
            NSDictionary(dictionary: dataMap),
            "[\(name)] data value"
        )
    }
}
