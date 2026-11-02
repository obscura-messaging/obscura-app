import Foundation

/// The lowercase UUID string for 16 bytes, or nil for any other length.
func uuidString(_ bytes: Data) -> String? {
    guard bytes.count == 16 else { return nil }
    return bytes.withUnsafeBytes { UUID(uuid: $0.loadUnaligned(as: uuid_t.self)) }.uuidString.lowercased()
}

func uuidBytes(_ uuid: String) -> Data? {
    UUID(uuidString: uuid).map { withUnsafeBytes(of: $0.uuid) { Data($0) } }
}
