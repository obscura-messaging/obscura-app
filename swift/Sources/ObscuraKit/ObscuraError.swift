import Foundation

public enum ObscuraError: Error, Equatable, LocalizedError {
    case notAuthenticated
    case invalidArgument(String)
    case invalidFriendCode
    case http(status: Int, body: String)
    case connectionFailed(String)
    case sendFailed(String)
    case protocolViolation(String)
    case storageFailed(String)
    case notPrimary
    case linkFailed(String)

    public var code: String {
        switch self {
        case .notAuthenticated: return "NOT_AUTHENTICATED"
        case .invalidArgument: return "INVALID_ARGUMENT"
        case .invalidFriendCode: return "INVALID_FRIEND_CODE"
        case .http: return "HTTP_ERROR"
        case .connectionFailed: return "CONNECTION_FAILED"
        case .sendFailed: return "SEND_FAILED"
        case .protocolViolation: return "PROTOCOL_VIOLATION"
        case .storageFailed: return "STORAGE_ERROR"
        case .notPrimary: return "NOT_PRIMARY"
        case .linkFailed: return "LINK_FAILED"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notAuthenticated: return "Not authenticated"
        case .invalidArgument(let reason): return "Invalid argument: \(reason)"
        case .invalidFriendCode: return "Invalid friend code"
        case .http(let status, let body): return "HTTP \(status): \(body)"
        case .connectionFailed(let reason): return "Connection failed: \(reason)"
        case .sendFailed(let reason): return "Send failed: \(reason)"
        case .protocolViolation(let reason): return "Protocol violation: \(reason)"
        case .storageFailed(let reason): return "Storage failed: \(reason)"
        case .notPrimary: return "Only the primary device can do this"
        case .linkFailed(let reason): return "Link failed: \(reason)"
        }
    }
}
