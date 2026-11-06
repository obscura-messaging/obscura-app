import Foundation
import Security

/// The per-user SQLCipher key, kept in the Keychain. A Notification Service Extension can read it
/// only through a shared `accessGroup`.
enum DatabaseSecret {
    static func getOrCreate(userId: String, accessGroup: String?) throws -> Data {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.barrelmaker.obscura.kit.dbsecret",
            kSecAttrAccount as String: "db_key_\(userId)",
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }

        var lookup = query
        lookup[kSecReturnData as String] = true
        var result: AnyObject?
        let found = SecItemCopyMatching(lookup as CFDictionary, &result)
        if found == errSecSuccess, let key = result as? Data, key.count == 32 { return key }
        guard found == errSecSuccess || found == errSecItemNotFound else {
            throw ObscuraError.storageFailed("Keychain read OSStatus \(found)")
        }

        var key = Data(count: 32)
        let random = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard random == errSecSuccess else { throw ObscuraError.storageFailed("secure random OSStatus \(random)") }

        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = key
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw ObscuraError.storageFailed("Keychain write OSStatus \(added)") }
        return key
    }
}
