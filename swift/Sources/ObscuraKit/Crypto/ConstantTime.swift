import Foundation

/// Constant-time comparison to prevent timing side-channel attacks on key material.
/// Returns true only if both Data values have identical length and content.
internal func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
