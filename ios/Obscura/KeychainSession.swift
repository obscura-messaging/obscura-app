import Foundation
import Security
import ObscuraKit

final class KeychainSession: SessionStorage {
    private func query(accessGroup: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "dev.barrelmaker.obscura.session",
            kSecAttrAccount as String: "session_data",
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    func save(_ session: [String: String]) throws {
        let identity = query(accessGroup: SharedContainer.keychainAccessGroup)
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(session),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let item = identity.merging(attributes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
            }
        }
        try requireSuccess(status, operation: "save")
    }

    func load() throws -> [String: String]? {
        var query = query(accessGroup: SharedContainer.keychainAccessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try requireSuccess(status, operation: "load")
        guard let data = result as? Data else {
            throw ObscuraError.storageFailed("Session keychain item is not data")
        }
        return try JSONDecoder().decode([String: String].self, from: data)
    }

    func clear() throws {
        let groups: [String?] = SharedContainer.keychainAccessGroup.map { [$0, nil] } ?? [nil]
        for group in groups {
            let status = SecItemDelete(query(accessGroup: group) as CFDictionary)
            if status != errSecItemNotFound { try requireSuccess(status, operation: "clear") }
        }
    }

    private func requireSuccess(_ status: OSStatus, operation: String) throws {
        guard status == errSecSuccess else {
            throw ObscuraError.storageFailed("Keychain session \(operation) failed (\(status))")
        }
    }
}
