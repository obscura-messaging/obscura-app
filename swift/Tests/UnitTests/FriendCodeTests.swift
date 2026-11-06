import XCTest
@testable import ObscuraKit

/// FriendCode is a user-facing wire format — it's QR-encoded and pasted between
/// phones. Round-trip stability and rejection of malformed input are the two
/// invariants we must never lose. Mirrors Kotlin `FriendCodeTest` 1:1 so the
/// two platforms can't drift on the shared format.
final class FriendCodeTests: XCTestCase {

    func testRoundTripsNormalUserIdAndUsername() throws {
        let encoded = FriendCode.encode(userId: "019f025a-3745-7de6-84b6-d932cae7d45f", username: "alice")
        let decoded = try FriendCode.decode(encoded)
        XCTAssertEqual(decoded.userId, "019f025a-3745-7de6-84b6-d932cae7d45f")
        XCTAssertEqual(decoded.username, "alice")
    }

    func testRoundTripsUnicodeUsername() throws {
        let decoded = try FriendCode.decode(FriendCode.encode(userId: "uid", username: "✨nolan✨"))
        XCTAssertEqual(decoded.username, "✨nolan✨")
    }

    func testDecodeIgnoresWhitespaceAndSoftHyphensAnywhere() throws {
        let encoded = FriendCode.encode(userId: "uid", username: "alice")
        let middle = encoded.index(encoded.startIndex, offsetBy: 6)
        let mangled = "  \n" + encoded[..<middle] + "\u{00AD} \n\u{00AD}" + encoded[middle...] + "\t  "
        let decoded = try FriendCode.decode(mangled)
        XCTAssertEqual(decoded.username, "alice")
    }

    func testDecodeNormalisesUrlSafeBase64() throws {
        let encoded = FriendCode.encode(userId: "uid", username: "alice")
        let urlSafe = encoded.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        let decoded = try FriendCode.decode(urlSafe)
        XCTAssertEqual(decoded.username, "alice")
    }

    func testDecodeRejectsEmptyString() {
        XCTAssertThrowsError(try FriendCode.decode("")) { XCTAssertEqual($0 as? ObscuraError, .invalidFriendCode) }
    }

    func testDecodeRejectsNonBase64Garbage() {
        XCTAssertThrowsError(try FriendCode.decode("not a friend code!!!"))
    }

    func testDecodeRejectsPayloadMissingRequiredFields() {
        // Valid base64, valid JSON, but no "u"/"n" keys.
        let empty = Data("{}".utf8).base64EncodedString()
        XCTAssertThrowsError(try FriendCode.decode(empty))
    }

    func testDecodeRejectsBlankIdentityOrUsername() {
        for (userId, username) in [("", "alice"), (" \n", "alice"), ("uid", ""), ("uid", " \t")] {
            XCTAssertThrowsError(try FriendCode.decode(FriendCode.encode(userId: userId, username: username))) {
                XCTAssertEqual($0 as? ObscuraError, .invalidFriendCode)
            }
        }
    }
}
