import Foundation

/// `base64({"n":username,"u":userId})`, shared with the web client.
enum FriendCode {
    static func encode(userId: String, username: String) -> String {
        // Two string values cannot fail to serialize.
        try! JSONSerialization.data(withJSONObject: ["u": userId, "n": username], options: .sortedKeys).base64EncodedString()
    }

    /// Ignores whitespace and soft hyphens, which copy-paste and text layout insert. Accepts URL-safe
    /// base64.
    static func decode(_ code: String) throws -> (userId: String, username: String) {
        let base64 = String(code.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) && $0 != "\u{00AD}" })
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base64),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              let userId = json["u"], !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let username = json["n"], !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw ObscuraError.invalidFriendCode }
        return (userId, username)
    }
}
