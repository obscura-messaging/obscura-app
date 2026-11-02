import Foundation

/// Wire <-> app-facing mappings, pinned by `protocol/conformance/wire.json`.
enum WireCodec {
    /// The set payload arm's field name in upper snake case; "" when unset or unknown.
    static func messageKind(_ payload: Obscura_Client_V1_ClientMessage.OneOf_Payload?) -> String {
        switch payload {
        case .friendRequest?: return "FRIEND_REQUEST"
        case .friendAccept?: return "FRIEND_ACCEPT"
        case .appEntry?: return "APP_ENTRY"
        case .typingSignal?: return "TYPING_SIGNAL"
        case .friendListSync?: return "FRIEND_LIST_SYNC"
        case nil: return ""
        }
    }

    static func decodeTypingState(_ state: Obscura_Client_V1_TypingState) -> TypingState? {
        switch state {
        case .started: return .started
        case .stopped: return .stopped
        case .unspecified, .UNRECOGNIZED: return nil
        }
    }

    static func encodeTypingState(_ state: TypingState) -> Obscura_Client_V1_TypingState {
        switch state {
        case .started: return .started
        case .stopped: return .stopped
        }
    }

    static func friendRecord(_ friend: Friend) -> Obscura_Client_V1_FriendRecord {
        var record = Obscura_Client_V1_FriendRecord()
        record.userID = friend.userId
        record.username = friend.username
        switch friend.status {
        case .pendingSent: record.status = .pendingSent
        case .pendingReceived: record.status = .pendingReceived
        case .accepted: record.status = .accepted
        }
        return record
    }

    /// Throws unless every record names a user and a known status.
    static func friends(_ records: [Obscura_Client_V1_FriendRecord]) throws
        -> [(userId: String, username: String, status: FriendStatus)] {
        try records.map { record in
            let status: FriendStatus
            switch record.status {
            case .pendingSent: status = .pendingSent
            case .pendingReceived: status = .pendingReceived
            case .accepted: status = .accepted
            case .unspecified, .UNRECOGNIZED:
                throw ObscuraError.protocolViolation("friend record \(record.userID) has status \(record.status.rawValue)")
            }
            guard !record.userID.isEmpty else { throw ObscuraError.protocolViolation("friend record without a user id") }
            return (record.userID, record.username, status)
        }
    }
}
