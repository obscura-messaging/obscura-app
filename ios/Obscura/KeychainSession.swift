import Foundation
import Security
import ObscuraCore

final class KeychainSession: SessionStorage, @unchecked Sendable {
    private func query(accessGroup: String?) -> [String: Any] {
        let bundleId = Bundle.main.bundleIdentifier ?? "dev.barrelmaker.obscura.dev"
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "\(bundleId).session",
            kSecAttrAccount as String: "session_data",
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    func save(data: [String: String]) throws {
        let encoded: Data
        do {
            encoded = try JSONEncoder().encode(data)
        } catch {
            throw ObscuraError.StorageFailed(reason: "Failed to encode session: \(error.localizedDescription)")
        }
        let identity = query(accessGroup: SharedContainer.keychainAccessGroup)
        let attributes: [String: Any] = [
            kSecValueData as String: encoded,
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
            throw ObscuraError.StorageFailed(reason: "Session keychain item is not data")
        }
        do {
            return try JSONDecoder().decode([String: String].self, from: data)
        } catch {
            throw ObscuraError.StorageFailed(reason: "Failed to decode session: \(error.localizedDescription)")
        }
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
            throw ObscuraError.StorageFailed(reason: "Keychain session \(operation) failed (\(status))")
        }
    }
}
