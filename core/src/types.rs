use crate::error::ObscuraError;
use crate::proto::client;

pub const EXPIRE_AFTER_VIEW_MS: i64 = 15 * 60 * 1000;
pub const MAX_EPHEMERAL_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const STORY_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

pub fn expires_at(sent_at: i64, viewed_at: Option<i64>) -> i64 {
    let max_expiry = sent_at.saturating_add(MAX_EPHEMERAL_AGE_MS);
    match viewed_at {
        None => max_expiry,
        Some(v) => max_expiry.min(v.saturating_add(EXPIRE_AFTER_VIEW_MS)),
    }
}

pub fn clamp_future_timestamp(sent_at: u64, now_ms: i64) -> i64 {
    let cap = now_ms.saturating_add(60_000);
    match i64::try_from(sent_at) {
        Ok(ts) if ts >= 0 => ts.min(cap),
        _ => cap,
    }
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    LoggedOut,
    Authenticated,
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginScenario {
    ExistingDevice,
    LinkRequired,
    DeviceMismatch,
    InvalidCredentials,
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TypingState {
    Started,
    Stopped,
}

impl TypingState {
    pub fn from_proto(raw: i32) -> Option<Self> {
        match client::TypingState::try_from(raw) {
            Ok(client::TypingState::Started) => Some(TypingState::Started),
            Ok(client::TypingState::Stopped) => Some(TypingState::Stopped),
            Ok(client::TypingState::Unspecified) | Err(_) => None,
        }
    }

    pub fn to_proto(self) -> i32 {
        match self {
            TypingState::Started => client::TypingState::Started as i32,
            TypingState::Stopped => client::TypingState::Stopped as i32,
        }
    }
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Photo,
    Video,
}

impl MediaType {
    pub fn from_wire(value: &str) -> Self {
        if value == "video" {
            MediaType::Video
        } else {
            MediaType::Photo
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            MediaType::Photo => "photo",
            MediaType::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationKind {
    Message,
    Pix,
}

impl ConversationKind {
    pub fn from_wire(value: &str) -> Result<Self, ObscuraError> {
        match value {
            "message" => Ok(ConversationKind::Message),
            "pix" => Ok(ConversationKind::Pix),
            other => Err(ObscuraError::invalid_arg(format!(
                "Invalid conversation item kind: {other}"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ConversationKind::Message => "message",
            ConversationKind::Pix => "pix",
        }
    }
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryModel {
    DirectMessage,
    Pix,
    Seen,
    Story,
    Profile,
}

impl EntryModel {
    pub fn as_str(&self) -> &'static str {
        match self {
            EntryModel::DirectMessage => "directMessage",
            EntryModel::Pix => "pix",
            EntryModel::Seen => "seen",
            EntryModel::Story => "story",
            EntryModel::Profile => "profile",
        }
    }
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendStatus {
    PendingSent,
    PendingReceived,
    Accepted,
}

impl FriendStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            FriendStatus::PendingSent => "pending_sent",
            FriendStatus::PendingReceived => "pending_received",
            FriendStatus::Accepted => "accepted",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "pending_sent" => Some(FriendStatus::PendingSent),
            "pending_received" => Some(FriendStatus::PendingReceived),
            "accepted" => Some(FriendStatus::Accepted),
            _ => None,
        }
    }
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct Friend {
    pub user_id: String,
    pub username: String,
    pub status: FriendStatus,
}

impl Friend {
    pub fn to_proto(&self) -> client::FriendRecord {
        let status = match self.status {
            FriendStatus::PendingSent => client::FriendStatus::PendingSent as i32,
            FriendStatus::PendingReceived => client::FriendStatus::PendingReceived as i32,
            FriendStatus::Accepted => client::FriendStatus::Accepted as i32,
        };
        client::FriendRecord {
            user_id: self.user_id.clone(),
            username: self.username.clone(),
            status,
        }
    }

    pub fn from_proto(record: &client::FriendRecord) -> Option<Self> {
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
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: Option<String>,
    pub is_primary: bool,
    pub is_this_device: bool,
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRef {
    pub id: String,
    pub media_type: MediaType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAttachment {
    pub id: String,
    pub content_key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub media_type: MediaType,
}

impl StoredAttachment {
    pub fn as_ref(&self) -> AttachmentRef {
        AttachmentRef {
            id: self.id.clone(),
            media_type: self.media_type,
        }
    }

    pub fn to_proto(&self) -> client::AttachmentPointer {
        client::AttachmentPointer {
            id: self.id.clone(),
            content_key: self.content_key.clone(),
            nonce: self.nonce.clone(),
            media_type: self.media_type.as_str().to_owned(),
        }
    }

    pub fn from_proto(att: &client::AttachmentPointer) -> Option<Self> {
        if att.id.trim().is_empty() || att.content_key.is_empty() || att.nonce.is_empty() {
            return None;
        }
        Some(StoredAttachment {
            id: att.id.clone(),
            content_key: att.content_key.clone(),
            nonce: att.nonce.clone(),
            media_type: MediaType::from_wire(&att.media_type),
        })
    }
}

#[derive(uniffi::Enum, Debug, Clone, PartialEq, Eq)]
pub enum ConversationContent {
    Message {
        text: String,
    },
    Pix {
        attachment: AttachmentRef,
        caption: Option<String>,
        caption_meta: Option<String>,
        display_duration: i32,
    },
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct ConversationItem {
    pub id: String,
    pub peer_user_id: String,
    pub author_user_id: String,
    pub sent_at: i64,
    pub viewed_at: Option<i64>,
    pub content: ConversationContent,
}

impl ConversationItem {
    pub fn message(
        id: String,
        peer_user_id: String,
        author_user_id: String,
        sent_at: i64,
        text: String,
        viewed_at: Option<i64>,
    ) -> Self {
        Self {
            id,
            peer_user_id,
            author_user_id,
            sent_at,
            viewed_at,
            content: ConversationContent::Message { text },
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pix(
        id: String,
        peer_user_id: String,
        author_user_id: String,
        sent_at: i64,
        attachment: AttachmentRef,
        caption: Option<String>,
        caption_meta: Option<String>,
        display_duration: i32,
        viewed_at: Option<i64>,
    ) -> Self {
        Self {
            id,
            peer_user_id,
            author_user_id,
            sent_at,
            viewed_at,
            content: ConversationContent::Pix {
                attachment,
                caption,
                caption_meta,
                display_duration,
            },
        }
    }

    pub fn expires_at(&self) -> i64 {
        expires_at(self.sent_at, self.viewed_at)
    }

    pub fn kind(&self) -> ConversationKind {
        match self.content {
            ConversationContent::Message { .. } => ConversationKind::Message,
            ConversationContent::Pix { .. } => ConversationKind::Pix,
        }
    }

    pub fn to_client_message(
        &self,
        attachment: Option<&StoredAttachment>,
    ) -> client::ClientMessage {
        let payload = match &self.content {
            ConversationContent::Pix {
                caption,
                caption_meta,
                display_duration,
                ..
            } => client::client_message::Payload::Pix(client::PixMessage {
                id: self.id.clone(),
                peer_user_id: self.peer_user_id.clone(),
                attachment: attachment.map(StoredAttachment::to_proto),
                caption: caption.clone().unwrap_or_default(),
                caption_meta: caption_meta.clone().unwrap_or_default(),
                display_duration_secs: (*display_duration).max(0) as u32,
            }),
            ConversationContent::Message { text } => {
                client::client_message::Payload::DirectMessage(client::DirectMessage {
                    id: self.id.clone(),
                    peer_user_id: self.peer_user_id.clone(),
                    content: text.clone(),
                })
            }
        };
        client::ClientMessage {
            timestamp: self.sent_at.max(0) as u64,
            payload: Some(payload),
        }
    }

    pub fn to_snapshot_record(
        &self,
        attachment: Option<&StoredAttachment>,
    ) -> client::StoredMessageRecord {
        match &self.content {
            ConversationContent::Message { text } => client::StoredMessageRecord {
                id: self.id.clone(),
                peer_user_id: self.peer_user_id.clone(),
                kind: ConversationKind::Message.as_str().to_owned(),
                author_user_id: self.author_user_id.clone(),
                sent_at: self.sent_at.max(0) as u64,
                viewed_at: self.viewed_at.unwrap_or(0).max(0) as u64,
                content: text.clone(),
                attachment: None,
                caption: String::new(),
                caption_meta: String::new(),
                display_duration_secs: 0,
            },
            ConversationContent::Pix {
                caption,
                caption_meta,
                display_duration,
                ..
            } => client::StoredMessageRecord {
                id: self.id.clone(),
                peer_user_id: self.peer_user_id.clone(),
                kind: ConversationKind::Pix.as_str().to_owned(),
                author_user_id: self.author_user_id.clone(),
                sent_at: self.sent_at.max(0) as u64,
                viewed_at: self.viewed_at.unwrap_or(0).max(0) as u64,
                content: String::new(),
                attachment: attachment.map(StoredAttachment::to_proto),
                caption: caption.clone().unwrap_or_default(),
                caption_meta: caption_meta.clone().unwrap_or_default(),
                display_duration_secs: (*display_duration).max(0) as u32,
            },
        }
    }
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct StoryItem {
    pub id: String,
    pub author_user_id: String,
    pub sent_at: i64,
    pub content: String,
    pub attachment: Option<AttachmentRef>,
    pub caption_meta: Option<String>,
}

impl StoryItem {
    pub fn new(
        id: String,
        author_user_id: String,
        sent_at: i64,
        content: String,
        attachment: Option<AttachmentRef>,
        caption_meta: Option<String>,
    ) -> Self {
        Self {
            id,
            author_user_id,
            sent_at,
            content,
            attachment,
            caption_meta,
        }
    }

    pub fn expires_at(&self) -> i64 {
        self.sent_at.saturating_add(STORY_MAX_AGE_MS)
    }

    pub fn to_client_message(
        &self,
        attachment: Option<&StoredAttachment>,
    ) -> client::ClientMessage {
        client::ClientMessage {
            timestamp: self.sent_at.max(0) as u64,
            payload: Some(client::client_message::Payload::Story(client::StoryPost {
                id: self.id.clone(),
                content: self.content.clone(),
                attachment: attachment.map(StoredAttachment::to_proto),
                caption_meta: self.caption_meta.clone().unwrap_or_default(),
            })),
        }
    }

    pub fn to_snapshot_record(
        &self,
        attachment: Option<&StoredAttachment>,
    ) -> client::StoredStoryRecord {
        client::StoredStoryRecord {
            id: self.id.clone(),
            author_user_id: self.author_user_id.clone(),
            sent_at: self.sent_at.max(0) as u64,
            content: self.content.clone(),
            attachment: attachment.map(StoredAttachment::to_proto),
            caption_meta: self.caption_meta.clone().unwrap_or_default(),
        }
    }
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct ProfileItem {
    pub user_id: String,
    pub author_device_id: String,
    pub updated_at: i64,
    pub display_name: String,
    pub bio: String,
}

impl ProfileItem {
    pub fn to_client_message(&self) -> client::ClientMessage {
        client::ClientMessage {
            timestamp: self.updated_at.max(0) as u64,
            payload: Some(client::client_message::Payload::Profile(
                client::ProfileUpdate {
                    display_name: self.display_name.clone(),
                    bio: self.bio.clone(),
                },
            )),
        }
    }

    pub fn to_snapshot_record(&self) -> client::StoredProfileRecord {
        client::StoredProfileRecord {
            user_id: self.user_id.clone(),
            author_device_id: self.author_device_id.clone(),
            updated_at: self.updated_at.max(0) as u64,
            display_name: self.display_name.clone(),
            bio: self.bio.clone(),
        }
    }
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct CaptureResult {
    pub undelivered_peer_user_ids: Vec<String>,
    pub story_undelivered: bool,
}

#[derive(uniffi::Enum, Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionStatus {
    Accepted,
    Rejected,
    Unknown,
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct SubmissionResult {
    pub user_id: String,
    pub device_id: Option<String>,
    pub status: SubmissionStatus,
    pub error: Option<String>,
}

#[derive(uniffi::Record, Debug, Clone, PartialEq, Eq)]
pub struct ObscuraClientConfig {
    pub api_url: String,
    pub database_path: Option<String>,
    pub database_key: Vec<u8>,
    pub device_name: String,
    pub attachment_cache_dir: Option<String>,
}

impl ObscuraClientConfig {
    pub fn validate(&self) -> Result<(), ObscuraError> {
        validate_api_url(&self.api_url)?;
        if self.device_name.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("deviceName must not be blank"));
        }
        if let Some(path) = &self.database_path {
            if path.trim().is_empty() {
                return Err(ObscuraError::invalid_arg("databasePath must not be blank"));
            }
            if self.database_key.len() != 32 {
                return Err(ObscuraError::invalid_arg(format!(
                    "db_key must be 32 bytes, got {}",
                    self.database_key.len()
                )));
            }
        }
        Ok(())
    }
}

pub fn validate_api_url(api_url: &str) -> Result<(), ObscuraError> {
    let invalid = || {
        ObscuraError::invalid_arg(format!(
            "API URL must use HTTPS (or loopback HTTP): {api_url}"
        ))
    };
    if api_url.contains('@')
        || api_url.contains('?')
        || api_url.contains('#')
        || api_url.chars().any(char::is_whitespace)
    {
        return Err(invalid());
    }
    let parsed = url::Url::parse(api_url).map_err(|_| invalid())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    let Some(host) = parsed.host_str() else {
        return Err(invalid());
    };
    if host.trim().is_empty() {
        return Err(invalid());
    }
    if parsed.port() == Some(0) {
        return Err(invalid());
    }
    // Check explicit port in raw URL isn't out of range or 0 (e.g. ":0")
    if let Some(after_scheme) = api_url
        .strip_prefix("https://")
        .or_else(|| api_url.strip_prefix("http://"))
    {
        let authority = after_scheme.split('/').next().unwrap_or("");
        if authority.is_empty() {
            return Err(invalid());
        }
        if let Some(port_str) = extract_port(authority) {
            let Ok(port) = port_str.parse::<u32>() else {
                return Err(invalid());
            };
            if !(1..=65535).contains(&port) {
                return Err(invalid());
            }
        }
    } else {
        return Err(invalid());
    }

    let scheme = parsed.scheme();
    let is_loopback = scheme == "http" && matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if !(scheme == "https" || is_loopback) {
        return Err(invalid());
    }
    Ok(())
}

fn extract_port(authority: &str) -> Option<&str> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (_, after_bracket) = rest.split_once(']')?;
        after_bracket.strip_prefix(':')
    } else {
        let (_, port) = authority.rsplit_once(':')?;
        Some(port)
    }
}

#[derive(uniffi::Object, Clone)]
pub struct LinkRequest {
    pub(crate) code: String,
    pub(crate) session_id: String,
    pub(crate) user_id: String,
    pub(crate) expires_at: i64,
    pub(crate) ephemeral_private_key: libsignal_protocol::PrivateKey,
    pub(crate) username: String,
    pub(crate) device_name: String,
    pub(crate) ticket: crate::client::LinkTicket,
}

impl std::fmt::Debug for LinkRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkRequest")
            .field("session_id", &self.session_id)
            .field("user_id", &self.user_id)
            .field("expires_at", &self.expires_at)
            .field("username", &self.username)
            .field("device_name", &self.device_name)
            .finish_non_exhaustive()
    }
}

#[uniffi::export]
impl LinkRequest {
    pub fn code(&self) -> String {
        self.code.clone()
    }
}
