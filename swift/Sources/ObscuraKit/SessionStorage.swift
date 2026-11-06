import Foundation

/// Where the kit keeps its session between launches. The kit is the only writer.
/// Keys: `token`, `refreshToken`, `userId`, `deviceId`, `username`.
public protocol SessionStorage: AnyObject, Sendable {
    func save(_ session: [String: String]) throws
    func load() throws -> [String: String]?
    func clear() throws
}
