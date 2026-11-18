use crate::proto::client::{self, client_message::Payload};
use crate::types::{Friend, FriendStatus, TypingState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayloadDisposition {
    Content,
    KitInternal,
    Droppable,
}

pub fn payload_disposition(payload: Option<&Payload>) -> PayloadDisposition {
    match payload {
        Some(
            Payload::DirectMessage(_)
            | Payload::Pix(_)
            | Payload::SeenReceipt(_)
            | Payload::Story(_)
            | Payload::Profile(_),
        ) => PayloadDisposition::Content,
        Some(Payload::FriendRequest(_) | Payload::FriendAccept(_) | Payload::FriendListSync(_)) => {
            PayloadDisposition::KitInternal
        }
        Some(Payload::TypingSignal(_)) | None => PayloadDisposition::Droppable,
    }
}

pub fn kind(payload: Option<&Payload>) -> &'static str {
    match payload {
        Some(Payload::FriendRequest(_)) => "FRIEND_REQUEST",
        Some(Payload::FriendAccept(_)) => "FRIEND_ACCEPT",
        Some(Payload::TypingSignal(_)) => "TYPING_SIGNAL",
        Some(Payload::FriendListSync(_)) => "FRIEND_LIST_SYNC",
        Some(Payload::DirectMessage(_)) => "DIRECT_MESSAGE",
        Some(Payload::Pix(_)) => "PIX",
        Some(Payload::SeenReceipt(_)) => "SEEN_RECEIPT",
        Some(Payload::Story(_)) => "STORY",
        Some(Payload::Profile(_)) => "PROFILE",
        None => "UNKNOWN",
    }
}

pub fn decode_typing_state(raw: i32) -> Option<TypingState> {
    match client::TypingState::try_from(raw) {
        Ok(client::TypingState::Started) => Some(TypingState::Started),
        Ok(client::TypingState::Stopped) => Some(TypingState::Stopped),
        Ok(client::TypingState::Unspecified) | Err(_) => None,
    }
}

pub fn encode_typing_state(state: TypingState) -> i32 {
    match state {
        TypingState::Started => client::TypingState::Started as i32,
        TypingState::Stopped => client::TypingState::Stopped as i32,
    }
}

pub fn encode_friend(friend: &Friend) -> client::FriendRecord {
    let status = match friend.status {
        FriendStatus::PendingSent => client::FriendStatus::PendingSent as i32,
        FriendStatus::PendingReceived => client::FriendStatus::PendingReceived as i32,
        FriendStatus::Accepted => client::FriendStatus::Accepted as i32,
    };
    client::FriendRecord {
        user_id: friend.user_id.clone(),
        username: friend.username.clone(),
        status,
    }
}

pub fn decode_friend(record: &client::FriendRecord) -> Option<Friend> {
    if record.user_id.trim().is_empty() {
        return None;
    }
    let status = match client::FriendStatus::try_from(record.status) {
        Ok(client::FriendStatus::PendingSent) => FriendStatus::PendingSent,
        Ok(client::FriendStatus::PendingReceived) => FriendStatus::PendingReceived,
        Ok(client::FriendStatus::Accepted) => FriendStatus::Accepted,
        Ok(client::FriendStatus::Unspecified) | Err(_) => return None,
    };
    Some(Friend {
        user_id: record.user_id.clone(),
        username: record.username.clone(),
        status,
    })
}
