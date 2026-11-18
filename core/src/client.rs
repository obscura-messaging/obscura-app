use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libsignal_protocol::{IdentityKeyPair, KeyPair, PrivateKey};
use prost::Message as _;
use rand::Rng;
use tokio::sync::{Mutex as AsyncMutex, Notify, mpsc, watch};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::auth::{AuthManager, Credentials, TokenStatus};
use crate::crypto::{attachment, link, prekeys};
use crate::error::ObscuraError;
use crate::messaging::messenger::{DecryptCommitError, Messenger};
use crate::messaging::sender::{MessageSender, SendReport};
use crate::network::api::APIClient;
use crate::network::gateway::Gateway;
use crate::network::transport::{ClientEventListener, ObscuraLogger, SessionStorage, Transport};
use crate::proto::client::{
    self, ClientMessage, EncryptedMessage, EntrySnapshot, FriendAccept, FriendListSync,
    FriendRequest, HistorySnapshot, LinkBundle, LinkCode, SeenReceipt, TypingSignal,
    client_message::Payload, encrypted_message,
};
use crate::proto::server::Envelope;
use crate::store::content_store::{self, FriendReplyAction, PendingFriendReply};
use crate::store::device_store::{self, LocalDevice};
use crate::store::friend_store::{self, FriendList};
use crate::store::signal_store::SignalStore;
use crate::store::{DbContext, DbHandle, PostCommitEffect, history_sync};
use crate::types::{
    AuthState, CaptureResult, ConnectionState, ConversationItem, DeviceInfo, EntryModel, Friend,
    FriendStatus, LinkRequest, LoginScenario, MediaAttachment, MediaType, ObscuraClientConfig,
    ProfileItem, StoryItem, SubmissionStatus, TypingState, clamp_future_timestamp, expires_at,
};
use crate::wire::codec::{self, PayloadDisposition, payload_disposition};
use crate::wire::friend_code;
use crate::wire::typing::{TypingTracker, typing_conv_id};
use crate::wire::uuid_codec::{is_uuid, uuid_string};

const MESSAGE_RECEIVED_CAPACITY: usize = 100;
const DEBUG_LOG_SIZE: usize = 200;
const PUSH_IDLE_MS: i64 = 500;
const PUSH_RECENT_ACTIVITY_MS: i64 = 10_000;
const LINK_POLL_MS: u64 = 250;

#[derive(Debug, Clone)]
pub struct AttachmentUpload {
    pub id: String,
    pub content_key: Vec<u8>,
    pub nonce: Vec<u8>,
}

impl AttachmentUpload {
    pub fn into_media(self, media_type: MediaType) -> MediaAttachment {
        MediaAttachment {
            id: self.id,
            content_key: self.content_key,
            nonce: self.nonce,
            media_type,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FriendFollowUp {
    None,
    Sync,
    Accept,
    ReplyAccept,
}

struct StoredReceive {
    message: ClientMessage,
    friend_follow_up: FriendFollowUp,
}

#[derive(uniffi::Object)]
pub struct ObscuraClient {
    pub(crate) db: DbHandle,
    pub(crate) auth: Arc<AuthManager>,
    pub(crate) api: APIClient,
    pub(crate) gateway: Gateway,
    pub(crate) messenger: Messenger,
    pub(crate) sender: MessageSender,
    pub(crate) typing: TypingTracker,
    logger: Arc<dyn ObscuraLogger>,
    attachment_cache_dir: Option<PathBuf>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    debug_log: Arc<Mutex<VecDeque<String>>>,
    entry_dispatcher_job: Mutex<Option<JoinHandle<()>>>,
    receive_job: Mutex<Option<JoinHandle<()>>>,
    prekey_sync_tx: mpsc::UnboundedSender<()>,
    prekey_sync_job: Mutex<Option<JoinHandle<()>>>,
    prekey_check_interval_ms: AtomicI64,
    prekey_sync_spacing_ms: AtomicI64,
    processed_envelopes_tx: watch::Sender<u64>,
    processed_envelopes_rx: watch::Receiver<u64>,
    last_processed_at_ms: AtomicI64,
    drain_mutex: AsyncMutex<()>,
    session_task_mutex: AsyncMutex<()>,
    link_cancel: Mutex<Option<CancellationToken>>,
    link_done_notify: Arc<Notify>,
    link_in_flight: Mutex<bool>,
    shutdown_token: CancellationToken,
}

#[uniffi::export(async_runtime = "tokio")]
impl ObscuraClient {
    #[uniffi::constructor]
    pub fn open(
        config: ObscuraClientConfig,
        session_storage: Arc<dyn SessionStorage>,
        transport: Arc<dyn Transport>,
        logger: Arc<dyn ObscuraLogger>,
        listener: Arc<dyn ClientEventListener>,
    ) -> Result<Arc<Self>, ObscuraError> {
        Self::open_with_clock(
            config,
            session_storage,
            transport,
            logger,
            listener,
            Arc::new(crate::runtime::now_ms),
        )
    }

    pub fn auth_state(&self) -> AuthState {
        self.auth.auth_state()
    }

    pub fn connection_state(&self) -> ConnectionState {
        self.gateway.state()
    }

    pub fn user_id(&self) -> Option<String> {
        self.auth.credentials().map(|c| c.user_id)
    }

    pub fn username(&self) -> Option<String> {
        self.auth.credentials().map(|c| c.username)
    }

    pub fn device_id(&self) -> Option<String> {
        self.auth.credentials().map(|c| c.device_id)
    }

    pub fn get_debug_log(&self) -> Vec<String> {
        self.debug_log
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub fn friend_code(&self) -> Result<String, ObscuraError> {
        let self_creds = self.auth.require_credentials()?;
        Ok(friend_code::encode(
            &self_creds.user_id,
            &self_creds.username,
        ))
    }

    pub async fn restore_persisted_session(&self) -> bool {
        match self.auth.restore().await {
            Ok(true) => {}
            Ok(false) => return false,
            Err(e) => {
                self.log(format!("SESSION restore failed: {e}"));
                return false;
            }
        }
        if let Err(e) = self.connect().await {
            self.log(format!("SESSION restored offline: {e}"));
        }
        true
    }

    pub async fn register(&self, username: String, password: String) -> Result<(), ObscuraError> {
        self.auth.register(&username, &password).await
    }

    pub async fn login(
        &self,
        username: String,
        password: String,
    ) -> Result<LoginScenario, ObscuraError> {
        self.auth.login(&username, &password).await
    }

    pub async fn reset_account(
        &self,
        username: String,
        password: String,
    ) -> Result<(), ObscuraError> {
        self.auth
            .reset_account(&username, &password, || self.wipe_device_internal(false))
            .await
    }

    pub async fn logout(&self) -> Result<(), ObscuraError> {
        self.end_session(true, None, None).await
    }

    pub async fn wipe_device(&self) -> Result<(), ObscuraError> {
        self.wipe_device_internal(true).await
    }

    pub async fn shutdown(&self) {
        self.shutdown_token.cancel();
        self.cancel_link().await;
        self.gateway.disconnect();
        self.auth.stop_background_tasks();
        self.typing.clear();
        let recv_job = self
            .receive_job
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(j) = recv_job {
            j.abort();
            let _ = j.await;
        }
        let pk_job = self
            .prekey_sync_job
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(j) = pk_job {
            j.abort();
            let _ = j.await;
        }
        let disp_job = self
            .entry_dispatcher_job
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(j) = disp_job {
            j.abort();
            let _ = j.await;
        }
        self.db.shutdown().await;
    }

    pub async fn is_primary(&self) -> Result<bool, ObscuraError> {
        self.db
            .read(|conn| Ok(device_store::get_local(conn)?.is_some_and(|d| d.is_primary())))
            .await
    }

    pub async fn begin_link(
        &self,
        username: String,
        password: String,
        device_name: String,
    ) -> Result<Arc<LinkRequest>, ObscuraError> {
        if device_name.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("deviceName must not be blank"));
        }
        let session = self
            .auth
            .take_or_create_link_session(&username, &password)
            .await?;
        let ephemeral = KeyPair::generate(&mut rand::rng());
        let code_proto = LinkCode {
            session_id: session.id.clone(),
            ephemeral_public_key: ephemeral.public_key.serialize().into_vec(),
            device_name: device_name.clone(),
        };
        Ok(Arc::new(LinkRequest {
            code: link::encode_code(&code_proto),
            session_id: session.id,
            user_id: session.user_id,
            expires_at: session.expires_at,
            ephemeral_private_key: ephemeral.private_key.serialize(),
            username,
            device_name,
        }))
    }

    pub async fn complete_link(&self, request: Arc<LinkRequest>) -> Result<(), ObscuraError> {
        let token = CancellationToken::new();
        {
            let mut lock = self.link_cancel.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(prev) = lock.replace(token.clone()) {
                prev.cancel();
            }
            *self
                .link_in_flight
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = true;
        }

        let res = self.complete_link_inner(&request, &token).await;

        {
            *self
                .link_in_flight
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = false;
            self.link_done_notify.notify_waiters();
        }
        res
    }

    pub async fn cancel_link(&self) {
        let token = self
            .link_cancel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(t) = token {
            t.cancel();
        }
        loop {
            let notified = self.link_done_notify.notified();
            if !*self
                .link_in_flight
                .lock()
                .unwrap_or_else(|p| p.into_inner())
            {
                break;
            }
            notified.await;
        }
    }

    pub async fn approve_link(&self, code: String) -> Result<(), ObscuraError> {
        let self_creds = self.require_primary().await?;
        let link_code = link::decode_code(&code)?;
        let peer_pub = link::public_key(&link_code)?;

        let (identity_bytes, friend_list) = self
            .db
            .read(|conn| {
                let (identity, _) = SignalStore::get_local_identity(conn)?
                    .ok_or_else(|| ObscuraError::storage("Identity not initialized"))?;
                let list = friend_store::list(conn)?;
                Ok((identity.serialize().into_vec(), list))
            })
            .await?;

        let history = self.upload_history_snapshot().await?;
        let bundle = LinkBundle {
            identity_key_pair: identity_bytes,
            user_id: self_creds.user_id,
            primary_device_id: self_creds.device_id,
            username: self_creds.username,
            friend_list_version: friend_list.version,
            friends: friend_list
                .friends
                .iter()
                .map(codec::encode_friend)
                .collect(),
            history,
        };
        let envelope = link::seal(&bundle.encode_to_vec(), &peer_pub)?;
        match self
            .api
            .approve_link_session(&link_code.session_id, envelope.encode_to_vec())
            .await
        {
            Ok(()) => Ok(()),
            Err(ObscuraError::Http { status: 404, .. }) => {
                Err(ObscuraError::link_failed("Link session expired or unknown"))
            }
            Err(e) => Err(e),
        }
    }

    pub async fn devices(&self) -> Result<Vec<DeviceInfo>, ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        let list = self.api.fetch_own_devices().await?;
        if list.iter().filter(|d| d.is_primary).count() != 1 {
            return Err(ObscuraError::protocol("The account has no primary device"));
        }
        Ok(list
            .into_iter()
            .map(|d| DeviceInfo {
                is_this_device: d.device_id == self_creds.device_id,
                device_id: d.device_id,
                name: d.name,
                is_primary: d.is_primary,
            })
            .collect())
    }

    pub async fn unlink_device(&self, device_id: String) -> Result<(), ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        let primary = self.is_primary().await?;
        if device_id == self_creds.device_id && primary {
            return Err(ObscuraError::invalid_arg(
                "The primary device cannot unlink itself; reset the account instead",
            ));
        }
        if device_id == self_creds.device_id {
            self.api.delete_device(&device_id).await?;
            self.wipe_device_internal(false).await
        } else if !primary {
            Err(ObscuraError::NotPrimary)
        } else {
            self.api.delete_device(&device_id).await?;
            let uid = self_creds.user_id;
            let dev = device_id;
            self.db
                .write_tx(move |ctx| device_store::remove(ctx.conn, &uid, &[dev]))
                .await
        }
    }

    pub async fn connect(&self) -> Result<(), ObscuraError> {
        self.auth.require_credentials()?;
        if prekeys::is_sync_due(&self.db, (self.clock)()).await? {
            self.request_prekey_sync();
        }
        self.gateway.connect().await?;
        self.log("CONNECTED");
        Ok(())
    }

    pub fn disconnect(&self) {
        self.gateway.disconnect();
        self.log("DISCONNECTED");
    }

    pub async fn process_pending_messages(&self, timeout_ms: i64) -> Result<i32, ObscuraError> {
        let _guard = self.drain_mutex.lock().await;
        let start = *self.processed_envelopes_rx.borrow();
        let deadline = (self.clock)().saturating_add(timeout_ms);
        let started_connected = self.connection_state() == ConnectionState::Connected;
        if !started_connected && !self.try_connect().await {
            return Ok(0);
        }
        self.await_idle(deadline).await;
        if started_connected
            && *self.processed_envelopes_rx.borrow() == start
            && (self.clock)() - self.last_processed_at_ms.load(Ordering::SeqCst)
                > PUSH_RECENT_ACTIVITY_MS
        {
            self.log("PUSH nothing drained on a connected socket; reconnecting");
            self.gateway.disconnect();
            if self.try_connect().await {
                self.await_idle(deadline).await;
            }
        }
        let end = *self.processed_envelopes_rx.borrow();
        Ok(end.saturating_sub(start) as i32)
    }

    pub async fn register_push_token(&self, token: String) -> Result<(), ObscuraError> {
        self.require_fresh_token().await?;
        self.api.register_push_token(&token).await
    }

    pub async fn get_friends(&self) -> Result<Vec<Friend>, ObscuraError> {
        self.db.read(friend_store::get_all).await
    }

    pub async fn add_friend_by_code(&self, code: String) -> Result<(), ObscuraError> {
        self.require_primary().await?;
        let decoded = friend_code::decode(&code)?;
        self.befriend(&decoded.user_id, &decoded.username).await
    }

    pub async fn accept_friend(&self, user_id: String) -> Result<(), ObscuraError> {
        self.require_primary().await?;
        let uid = user_id.clone();
        let exists = self
            .db
            .read(move |conn| friend_store::get(conn, &uid))
            .await?;
        if exists.is_none() {
            return Err(ObscuraError::invalid_arg(format!(
                "No friend request from {user_id}"
            )));
        }
        self.send_friend_accept(&user_id).await?;
        let uid = user_id.clone();
        let updated = self
            .db
            .write_tx(move |ctx| friend_store::update_status(ctx, &uid, FriendStatus::Accepted))
            .await?;
        if updated {
            self.sync_friend_list().await;
        }
        Ok(())
    }

    pub async fn remove_friend(&self, user_id: String) -> Result<(), ObscuraError> {
        self.require_primary().await?;
        let uid = user_id.clone();
        let removed = self
            .db
            .write_tx(move |ctx| {
                let rem = friend_store::remove(ctx, &uid)?;
                device_store::remove_by_user(ctx.conn, &uid)?;
                Ok(rem)
            })
            .await?;
        if removed {
            self.sync_friend_list().await;
        }
        Ok(())
    }

    pub async fn get_messages(&self) -> Result<Vec<ConversationItem>, ObscuraError> {
        self.db.read(content_store::get_messages).await
    }

    pub async fn send_message(
        &self,
        peer_user_id: String,
        content: String,
    ) -> Result<String, ObscuraError> {
        if peer_user_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("peerUserId must not be blank"));
        }
        let self_creds = self.require_fresh_token().await?;
        if peer_user_id == self_creds.user_id {
            return Err(ObscuraError::invalid_arg("Cannot message yourself"));
        }
        let sent_at = (self.clock)();
        let id = generate_entry_id("dm", sent_at);
        let item = ConversationItem::message(
            id.clone(),
            peer_user_id.clone(),
            self_creds.user_id.clone(),
            sent_at,
            content,
            None,
            false,
        );
        let item_for_db = item.clone();
        self.db
            .write_tx(move |ctx| content_store::insert_conversation(ctx.conn, &item_for_db))
            .await?;

        let accepted = self.accepted_friend_ids(&self_creds.user_id).await?;
        let peers: Vec<String> = if accepted.contains(&peer_user_id) {
            vec![peer_user_id.clone()]
        } else {
            Vec::new()
        };
        let report = self
            .send_to_peers_and_self(&self_creds.user_id, &peers, &item.to_client_message())
            .await;
        if peers.is_empty()
            || !report
                .recipients
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
        {
            let id_clone = id.clone();
            self.db
                .write_tx(move |ctx| {
                    content_store::set_conversation_undelivered(ctx.conn, &id_clone, true)
                })
                .await?;
            return Err(send_failed(EntryModel::DirectMessage, &report));
        }
        Ok(id)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_capture(
        &self,
        file_path: String,
        media_type: MediaType,
        caption: String,
        caption_meta: Option<String>,
        display_duration: i32,
        peer_user_ids: Vec<String>,
        to_story: bool,
    ) -> Result<CaptureResult, ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        for peer in &peer_user_ids {
            if peer.trim().is_empty() {
                return Err(ObscuraError::invalid_arg("peerUserId must not be blank"));
            }
            if peer == &self_creds.user_id {
                return Err(ObscuraError::invalid_arg("Cannot message yourself"));
            }
        }
        let attachment = self
            .upload_attachment_path(&file_path)
            .await?
            .into_media(media_type);
        let mut undelivered_peers = Vec::new();
        for peer in &peer_user_ids {
            if let Err(e) = self
                .send_pix(
                    peer,
                    attachment.clone(),
                    &caption,
                    caption_meta.as_deref(),
                    display_duration,
                )
                .await
            {
                self.log(format!("send.pix failed: {e}"));
                undelivered_peers.push(peer.clone());
            }
        }
        let mut story_undelivered = false;
        if to_story
            && let Err(e) = self
                .post_story(caption, Some(attachment), caption_meta)
                .await
        {
            self.log(format!("send.story failed: {e}"));
            story_undelivered = true;
        }
        Ok(CaptureResult {
            undelivered_peer_user_ids: undelivered_peers,
            story_undelivered,
        })
    }

    pub async fn download_attachment_to_cache(
        &self,
        entry_id: String,
    ) -> Result<String, ObscuraError> {
        let dir = self
            .attachment_cache_dir
            .as_ref()
            .ok_or_else(|| ObscuraError::invalid_arg("attachmentCacheDir is not configured"))?
            .clone();
        let now = (self.clock)();
        let eid = entry_id.clone();
        let att = self
            .db
            .read(move |conn| content_store::get_attachment(conn, &eid, now))
            .await?
            .ok_or_else(|| {
                ObscuraError::invalid_arg(format!("No attachment for entry {entry_id}"))
            })?;

        if let Some(cached) = attachment::read_cached(&dir, &att.id) {
            return Ok(cached.to_string_lossy().into_owned());
        }

        let data = self
            .download_decrypted_attachment(&att.id, &att.content_key, &att.nonce)
            .await?;
        let written = attachment::write_cached(&dir, &att.id, &data)?;
        Ok(written.to_string_lossy().into_owned())
    }

    pub async fn mark_seen(&self, entry_id: String) -> Result<(), ObscuraError> {
        if entry_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("entryId must not be blank"));
        }
        let self_creds = self.require_fresh_token().await?;
        let eid = entry_id.clone();
        let Some(row) = self
            .db
            .read(move |conn| content_store::get_conversation(conn, &eid))
            .await?
        else {
            return Ok(());
        };
        if row.author_user_id == self_creds.user_id || row.viewed_at.is_some() {
            return Ok(());
        }
        let now = (self.clock)();
        let exp = expires_at(row.sent_at, Some(now));
        let eid = entry_id.clone();
        self.db
            .write_tx(move |ctx| content_store::mark_conversation_viewed(ctx.conn, &eid, now, exp))
            .await?;

        let msg = ClientMessage {
            timestamp: now.max(0) as u64,
            payload: Some(Payload::SeenReceipt(SeenReceipt {
                entry_id,
                peer_user_id: row.peer_user_id.clone(),
                viewed_at: now.max(0) as u64,
            })),
        };
        let accepted = self.accepted_friend_ids(&self_creds.user_id).await?;
        let peers: Vec<String> = if accepted.contains(&row.peer_user_id) {
            vec![row.peer_user_id]
        } else {
            Vec::new()
        };
        self.send_to_peers_and_self(&self_creds.user_id, &peers, &msg)
            .await;
        Ok(())
    }

    pub async fn get_stories(&self) -> Result<Vec<StoryItem>, ObscuraError> {
        let now = (self.clock)();
        self.db
            .read(move |conn| content_store::get_stories(conn, now))
            .await
    }

    pub async fn post_story(
        &self,
        content: String,
        attachment: Option<MediaAttachment>,
        caption_meta: Option<String>,
    ) -> Result<String, ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        let sent_at = (self.clock)();
        let id = generate_entry_id("story", sent_at);
        let item = StoryItem::new(
            id.clone(),
            self_creds.user_id.clone(),
            sent_at,
            content,
            attachment,
            caption_meta.filter(|s| !s.is_empty()),
            false,
        );
        let item_for_db = item.clone();
        self.db
            .write_tx(move |ctx| content_store::insert_story(ctx.conn, &item_for_db))
            .await?;

        let peers: Vec<String> = self
            .accepted_friend_ids(&self_creds.user_id)
            .await?
            .into_iter()
            .collect();
        let report = self
            .send_to_peers_and_self(&self_creds.user_id, &peers, &item.to_client_message())
            .await;
        if !peers.is_empty()
            && !report
                .recipients
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
        {
            let id_clone = id.clone();
            self.db
                .write_tx(move |ctx| {
                    content_store::set_story_undelivered(ctx.conn, &id_clone, true)
                })
                .await?;
            return Err(send_failed(EntryModel::Story, &report));
        }
        Ok(id)
    }

    pub async fn get_profiles(&self) -> Result<Vec<ProfileItem>, ObscuraError> {
        self.db.read(content_store::get_profiles).await
    }

    pub async fn update_profile(
        &self,
        display_name: String,
        bio: String,
    ) -> Result<(), ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        let uid = self_creds.user_id.clone();
        let existing = self
            .db
            .read(move |conn| content_store::get_profile(conn, &uid))
            .await?;
        let now = (self.clock)();
        let updated_at = now.max(existing.map(|e| e.updated_at + 1).unwrap_or(1));
        let item = ProfileItem {
            user_id: self_creds.user_id.clone(),
            author_device_id: self_creds.device_id.clone(),
            updated_at,
            display_name,
            bio,
            undelivered: false,
        };
        let item_for_db = item.clone();
        self.db
            .write_tx(move |ctx| content_store::insert_profile(ctx.conn, &item_for_db))
            .await?;

        let peers: Vec<String> = self
            .accepted_friend_ids(&self_creds.user_id)
            .await?
            .into_iter()
            .collect();
        let report = self
            .send_to_peers_and_self(&self_creds.user_id, &peers, &item.to_client_message())
            .await;
        if !peers.is_empty()
            && !report
                .recipients
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
        {
            let uid = self_creds.user_id;
            self.db
                .write_tx(move |ctx| {
                    content_store::set_profile_undelivered(ctx.conn, &uid, updated_at, true)
                })
                .await?;
            return Err(send_failed(EntryModel::Profile, &report));
        }
        Ok(())
    }

    pub async fn flush_outbox(&self) -> Result<i32, ObscuraError> {
        let self_creds = self.require_fresh_token().await?;
        let accepted = self.accepted_friend_ids(&self_creds.user_id).await?;
        let all_accepted: Vec<String> = accepted.iter().cloned().collect();
        let mut delivered = 0i32;

        let undelivered_msgs = self
            .db
            .read(content_store::get_undelivered_messages)
            .await?;
        for row in undelivered_msgs {
            if !accepted.contains(&row.peer_user_id) {
                continue;
            }
            let peers = vec![row.peer_user_id.clone()];
            let report = self
                .send_to_peers_and_self(&self_creds.user_id, &peers, &row.to_client_message())
                .await;
            if report
                .recipients
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
            {
                let row_id = row.id;
                self.db
                    .write_tx(move |ctx| {
                        content_store::set_conversation_undelivered(ctx.conn, &row_id, false)
                    })
                    .await?;
                delivered += 1;
            }
        }

        let undelivered_stories = self.db.read(content_store::get_undelivered_stories).await?;
        for row in undelivered_stories {
            let report = self
                .send_to_peers_and_self(
                    &self_creds.user_id,
                    &all_accepted,
                    &row.to_client_message(),
                )
                .await;
            if all_accepted.is_empty()
                || report
                    .recipients
                    .iter()
                    .any(|r| r.status == SubmissionStatus::Accepted)
            {
                let row_id = row.id;
                self.db
                    .write_tx(move |ctx| {
                        content_store::set_story_undelivered(ctx.conn, &row_id, false)
                    })
                    .await?;
                delivered += 1;
            }
        }

        let undelivered_profiles = self
            .db
            .read(content_store::get_undelivered_profiles)
            .await?;
        for row in undelivered_profiles {
            let report = self
                .send_to_peers_and_self(
                    &self_creds.user_id,
                    &all_accepted,
                    &row.to_client_message(),
                )
                .await;
            if all_accepted.is_empty()
                || report
                    .recipients
                    .iter()
                    .any(|r| r.status == SubmissionStatus::Accepted)
            {
                let uid = row.user_id;
                let updated_at = row.updated_at;
                self.db
                    .write_tx(move |ctx| {
                        content_store::set_profile_undelivered(ctx.conn, &uid, updated_at, false)
                    })
                    .await?;
                delivered += 1;
            }
        }

        Ok(delivered)
    }

    pub async fn sweep_expired(&self) -> Result<Vec<EntryModel>, ObscuraError> {
        self.sweep_expired_at((self.clock)()).await
    }

    pub async fn send_typing(
        &self,
        peer_user_id: String,
        state: TypingState,
    ) -> Result<(), ObscuraError> {
        if peer_user_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("peerUserId must not be blank"));
        }
        let self_creds = self.auth.require_credentials()?;
        let context_id = typing_conv_id(&self_creds.user_id, &peer_user_id);
        self.send_typing_in_context(&[peer_user_id], &context_id, state)
            .await
    }

    pub fn observe_peer_typing(&self, peer_user_id: String) -> Result<(), ObscuraError> {
        if peer_user_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("peerUserId must not be blank"));
        }
        let self_creds = self.auth.require_credentials()?;
        let context_id = typing_conv_id(&self_creds.user_id, &peer_user_id);
        self.typing.observe_peer(&peer_user_id, &context_id);
        Ok(())
    }

    pub fn stop_observing_peer_typing(&self, peer_user_id: String) {
        self.typing.stop_observing_peer(&peer_user_id);
    }
}

impl ObscuraClient {
    pub fn open_with_clock(
        config: ObscuraClientConfig,
        session_storage: Arc<dyn SessionStorage>,
        transport: Arc<dyn Transport>,
        logger: Arc<dyn ObscuraLogger>,
        listener: Arc<dyn ClientEventListener>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Result<Arc<Self>, ObscuraError> {
        config.validate()?;
        let db = DbHandle::open(config.database_path.as_deref(), &config.database_key, None)?;

        let debug_log = Arc::new(Mutex::new(VecDeque::with_capacity(DEBUG_LOG_SIZE)));
        let entry_queue = Arc::new(Mutex::new(VecDeque::with_capacity(
            MESSAGE_RECEIVED_CAPACITY,
        )));
        let entry_notify = Arc::new(Notify::new());

        let listener_for_auth = Arc::clone(&listener);
        let auth = AuthManager::new(
            db.clone(),
            session_storage,
            config.device_name.clone(),
            Arc::clone(&logger),
            Arc::new(move |st| listener_for_auth.on_auth_state_changed(st)),
            Arc::clone(&clock),
        );

        let auth_for_refresh = Arc::clone(&auth);
        let refresh_cb: crate::network::api::RefreshCallback = Arc::new(move || {
            let a = Arc::clone(&auth_for_refresh);
            Box::pin(async move { a.refresh().await })
        });
        let auth_for_token = Arc::clone(&auth);
        let token_cb: crate::network::api::TokenGetter =
            Arc::new(move || auth_for_token.credentials().map(|c| c.token));

        let api = APIClient::new(
            &config.api_url,
            Arc::clone(&transport),
            refresh_cb,
            token_cb,
        );

        let auth_for_gw = Arc::clone(&auth);
        let before_connect: crate::network::gateway::BeforeConnectFn = Arc::new(move || {
            let a = Arc::clone(&auth_for_gw);
            Box::pin(async move {
                if a.ensure_fresh_token().await? == TokenStatus::Rejected {
                    return Err(ObscuraError::NotAuthenticated);
                }
                a.require_credentials()?;
                Ok(())
            })
        });
        let listener_for_gw = Arc::clone(&listener);
        let debug_for_gw = Arc::clone(&debug_log);
        let logger_for_gw = Arc::clone(&logger);
        let clock_for_gw = Arc::clone(&clock);
        let gateway = Gateway::new(
            api.clone(),
            transport,
            before_connect,
            Arc::new(move |st| listener_for_gw.on_connection_state_changed(st)),
            Arc::new(move |msg| {
                append_log(&debug_for_gw, &logger_for_gw, (clock_for_gw)(), &msg);
            }),
        );

        let auth_for_msgr = Arc::clone(&auth);
        let messenger = Messenger::new(
            db.clone(),
            api.clone(),
            Arc::new(move || auth_for_msgr.credentials().map(|c| c.device_id)),
        );
        let auth_for_sender = Arc::clone(&auth);
        let sender = MessageSender::new(
            api.clone(),
            messenger.clone(),
            db.clone(),
            Arc::clone(&logger),
            Arc::new(move || auth_for_sender.credentials().map(|c| c.device_id)),
        );

        let listener_for_typing = Arc::clone(&listener);
        let typing = TypingTracker::with_listener(Arc::new(move |peer, is_typing| {
            listener_for_typing.on_peer_typing_changed(peer.to_owned(), is_typing);
        }));

        let (prekey_sync_tx, mut prekey_sync_rx) = mpsc::unbounded_channel::<()>();
        let (processed_envelopes_tx, processed_envelopes_rx) = watch::channel(0u64);

        let client = Arc::new(Self {
            db: db.clone(),
            auth: Arc::clone(&auth),
            api,
            gateway,
            messenger,
            sender,
            typing,
            logger: Arc::clone(&logger),
            attachment_cache_dir: config.attachment_cache_dir.map(PathBuf::from),
            clock: Arc::clone(&clock),
            debug_log: Arc::clone(&debug_log),
            entry_dispatcher_job: Mutex::new(None),
            receive_job: Mutex::new(None),
            prekey_sync_tx,
            prekey_sync_job: Mutex::new(None),
            prekey_check_interval_ms: AtomicI64::new(prekeys::CHECK_INTERVAL_MS as i64),
            prekey_sync_spacing_ms: AtomicI64::new(prekeys::SYNC_SPACING_MS as i64),
            processed_envelopes_tx,
            processed_envelopes_rx,
            last_processed_at_ms: AtomicI64::new(0),
            drain_mutex: AsyncMutex::new(()),
            session_task_mutex: AsyncMutex::new(()),
            link_cancel: Mutex::new(None),
            link_done_notify: Arc::new(Notify::new()),
            link_in_flight: Mutex::new(false),
            shutdown_token: CancellationToken::new(),
        });

        let debug_for_eff = Arc::clone(&debug_log);
        let logger_for_eff = Arc::clone(&logger);
        let listener_for_eff = Arc::clone(&listener);
        let clock_for_eff = Arc::clone(&clock);
        let queue_for_eff = Arc::clone(&entry_queue);
        let notify_for_eff = Arc::clone(&entry_notify);
        db.set_dispatcher(Arc::new(move |effect| match effect {
            PostCommitEffect::IdentityChanged(uid) => {
                append_log(
                    &debug_for_eff,
                    &logger_for_eff,
                    (clock_for_eff)(),
                    &format!("IDENTITY changed for {uid}; sessions with its devices dropped"),
                );
                logger_for_eff.identity_changed(uid);
            }
            PostCommitEffect::FriendsChanged => {
                listener_for_eff.on_friends_changed();
            }
            PostCommitEffect::EntryInboxed(model) => {
                let mut q = queue_for_eff.lock().unwrap_or_else(|p| p.into_inner());
                if q.len() >= MESSAGE_RECEIVED_CAPACITY {
                    q.pop_front();
                }
                q.push_back(model);
                drop(q);
                notify_for_eff.notify_one();
            }
        }));

        let queue_for_disp = Arc::clone(&entry_queue);
        let notify_for_disp = Arc::clone(&entry_notify);
        let listener_for_disp = Arc::clone(&listener);
        let disp_job = crate::runtime::spawn(async move {
            loop {
                let next = {
                    let mut q = queue_for_disp.lock().unwrap_or_else(|p| p.into_inner());
                    q.pop_front()
                };
                if let Some(model) = next {
                    listener_for_disp.on_message_received(model);
                } else {
                    notify_for_disp.notified().await;
                }
            }
        });
        *client
            .entry_dispatcher_job
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(disp_job);

        let weak_for_rejected = Arc::downgrade(&client);
        let api_for_bind = client.api.clone();
        auth.bind(
            api_for_bind,
            Arc::new(move |creds, ver| {
                let weak = weak_for_rejected.clone();
                Box::pin(async move {
                    if let Some(c) = weak.upgrade() {
                        let _ = c.end_session(false, Some(&creds), Some(ver)).await;
                    }
                })
            }),
        );

        let weak_for_recv = Arc::downgrade(&client);
        let gw_for_recv = client.gateway.clone();
        let recv_job = crate::runtime::spawn(async move {
            loop {
                let env = gw_for_recv.next_envelope().await;
                let Some(c) = weak_for_recv.upgrade() else {
                    break;
                };
                c.receive_envelope(env).await;
            }
        });
        *client.receive_job.lock().unwrap_or_else(|p| p.into_inner()) = Some(recv_job);

        let weak_for_pk = Arc::downgrade(&client);
        let weak_for_pk_timer = Arc::downgrade(&client);
        let pk_job = crate::runtime::spawn(async move {
            let timer = crate::runtime::spawn(async move {
                loop {
                    let Some(c) = weak_for_pk_timer.upgrade() else {
                        break;
                    };
                    let interval = c.prekey_check_interval_ms.load(Ordering::SeqCst).max(1) as u64;
                    drop(c);
                    tokio::time::sleep(Duration::from_millis(interval)).await;
                    let Some(c) = weak_for_pk_timer.upgrade() else {
                        break;
                    };
                    c.request_prekey_sync();
                }
            });
            while prekey_sync_rx.recv().await.is_some() {
                while prekey_sync_rx.try_recv().is_ok() {}
                let Some(c) = weak_for_pk.upgrade() else {
                    break;
                };
                if c.auth.credentials().is_none() {
                    continue;
                }
                c.sync_prekeys().await;
                let spacing = c.prekey_sync_spacing_ms.load(Ordering::SeqCst).max(1) as u64;
                drop(c);
                tokio::time::sleep(Duration::from_millis(spacing)).await;
            }
            timer.abort();
        });
        *client
            .prekey_sync_job
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(pk_job);

        Ok(client)
    }

    pub async fn sweep_expired_at(&self, now: i64) -> Result<Vec<EntryModel>, ObscuraError> {
        let outcome = self
            .db
            .write_tx(move |ctx| content_store::sweep_expired_in_tx(ctx.conn, now))
            .await?;
        if outcome.should_checkpoint {
            self.db.truncate_wal().await?;
        }
        for media_ref in &outcome.purged_media_refs {
            if let Some(ref dir) = self.attachment_cache_dir {
                attachment::purge_cached(dir, media_ref);
            }
            let mref = media_ref.clone();
            self.db
                .write_tx(move |ctx| content_store::remove_pending_media_purge(ctx.conn, &mref))
                .await?;
        }
        Ok(outcome.touched_models)
    }

    pub async fn receive_envelope(&self, envelope: Envelope) {
        self.receive_envelope_with_ack(envelope, |id| self.gateway.ack(id))
            .await;
    }

    pub async fn receive_envelope_with_ack<F>(&self, envelope: Envelope, ack: F)
    where
        F: FnOnce(Vec<u8>) -> Result<(), ObscuraError>,
    {
        let _task_guard = self.session_task_mutex.lock().await;
        let session_gen = self.auth.generation();
        let Some(envelope_id) = uuid_string(&envelope.id) else {
            self.log(
                "RECV malformed envelope (id, sender or sender device is not 16 bytes); not acked",
            );
            return;
        };
        let Some(sender_user_id) = uuid_string(&envelope.sender_user_id) else {
            self.log(
                "RECV malformed envelope (id, sender or sender device is not 16 bytes); not acked",
            );
            return;
        };
        let Some(sender_device_id) = uuid_string(&envelope.sender_device_id) else {
            self.log(
                "RECV malformed envelope (id, sender or sender device is not 16 bytes); not acked",
            );
            return;
        };

        let env_id_check = envelope_id.clone();
        let pre_check: Result<(bool, Option<PendingFriendReply>), ObscuraError> = self
            .db
            .read(move |conn| {
                Ok((
                    content_store::contains_envelope(conn, &env_id_check)?,
                    content_store::get_pending_friend_reply(conn, &env_id_check)?,
                ))
            })
            .await;

        let pending_reply = match pre_check {
            Ok((true, _)) => {
                self.acknowledge(envelope.id, &envelope_id, ack);
                return;
            }
            Ok((false, pending)) => pending,
            Err(e) => {
                self.log(format!(
                    "RECV duplicate lookup failed for {envelope_id}: {e}"
                ));
                self.logger.database_error(
                    "content".to_owned(),
                    "containsEnvelope".to_owned(),
                    e.to_string(),
                );
                return;
            }
        };

        if let Some(reply) = pending_reply {
            if let Err(e) = self.execute_pending_friend_reply(&reply).await {
                self.log(format!("RECV FRIEND_REQUEST not stored: {e}"));
                self.logger.database_error(
                    "receive".to_owned(),
                    "FRIEND_REQUEST".to_owned(),
                    e.to_string(),
                );
                return;
            }
            self.acknowledge(envelope.id, &envelope_id, ack);
            return;
        }

        let encrypted = match EncryptedMessage::decode(&envelope.message[..]) {
            Ok(enc) => enc,
            Err(e) => {
                self.log(format!("RECV decrypt failed from {sender_user_id}: {e}"));
                self.logger.decrypt_failed(sender_user_id, e.to_string());
                return;
            }
        };
        let is_prekey_msg = encrypted.r#type == encrypted_message::Type::PrekeyMessage as i32;

        let sender_uid_for_tx = sender_user_id.clone();
        let sender_dev_for_tx = sender_device_id.clone();
        let env_id_for_tx = envelope_id.clone();
        let self_uid = self.auth.credentials().map(|c| c.user_id);
        let now_ms = (self.clock)();

        let decrypt_res = self
            .messenger
            .decrypt_and_commit(
                &sender_user_id,
                &sender_device_id,
                encrypted,
                move |ctx, plaintext| {
                    let parsed = match ClientMessage::decode(&plaintext[..]) {
                        Ok(m) => m,
                        Err(_) => {
                            let _ = content_store::record_envelope(ctx.conn, &env_id_for_tx)?;
                            return Ok(None);
                        }
                    };
                    store_decrypted_in_tx(
                        ctx,
                        parsed,
                        &sender_uid_for_tx,
                        &sender_dev_for_tx,
                        &env_id_for_tx,
                        self_uid.as_deref(),
                        now_ms,
                    )
                    .map(Some)
                },
            )
            .await;

        let stored = match decrypt_res {
            Ok(Some((stored, logs))) => {
                for l in logs {
                    self.log(l);
                }
                Some(stored)
            }
            Ok(None) => {
                self.log(format!(
                    "RECV invalid client message from {sender_user_id}: failed to decode protobuf; dropped"
                ));
                self.logger.log(format!(
                    "dropped an unparseable client message from {sender_user_id}"
                ));
                None
            }
            Err(DecryptCommitError::DuplicatedMessage) => {
                self.log(format!(
                    "RECV redelivered envelope {envelope_id} was already processed; acked"
                ));
                self.acknowledge(envelope.id, &envelope_id, ack);
                return;
            }
            Err(DecryptCommitError::DecryptFailed(reason)) => {
                self.log(format!(
                    "RECV decrypt failed from {sender_user_id}: {reason}"
                ));
                self.logger.decrypt_failed(sender_user_id, reason);
                return;
            }
            Err(DecryptCommitError::DatabaseError(stage, reason)) => {
                self.log(format!("RECV {stage} not stored: {reason}"));
                self.logger
                    .database_error(stage.to_owned(), "receive".to_owned(), reason);
                return;
            }
        };

        if self.auth.generation() != session_gen {
            return;
        }

        if let Some(stored) = stored {
            let arm_name = codec::kind(stored.message.payload.as_ref());
            if let Err(e) = self
                .follow_up(stored, &sender_user_id, &sender_device_id, &envelope_id)
                .await
            {
                self.log(format!("RECV {arm_name} not stored: {e}"));
                self.logger.database_error(
                    "receive".to_owned(),
                    arm_name.to_owned(),
                    e.to_string(),
                );
                return;
            }
        }

        if self.auth.generation() != session_gen {
            return;
        }

        if is_prekey_msg {
            self.request_prekey_sync();
        }
        self.acknowledge(envelope.id, &envelope_id, ack);
    }

    pub async fn route_message(
        &self,
        message: ClientMessage,
        sender_user_id: &str,
        sender_device_id: &str,
        envelope_id: &str,
    ) -> Result<(), ObscuraError> {
        let s_uid = sender_user_id.to_owned();
        let s_dev = sender_device_id.to_owned();
        let env_id = envelope_id.to_owned();
        let self_uid = self.auth.credentials().map(|c| c.user_id);
        let now_ms = (self.clock)();
        let (stored, logs) = self
            .db
            .write_tx(move |ctx| {
                store_decrypted_in_tx(
                    ctx,
                    message,
                    &s_uid,
                    &s_dev,
                    &env_id,
                    self_uid.as_deref(),
                    now_ms,
                )
            })
            .await?;
        for l in logs {
            self.log(l);
        }
        self.follow_up(stored, sender_user_id, sender_device_id, envelope_id)
            .await
    }

    async fn follow_up(
        &self,
        stored: StoredReceive,
        sender_user_id: &str,
        sender_device_id: &str,
        envelope_id: &str,
    ) -> Result<(), ObscuraError> {
        match payload_disposition(stored.message.payload.as_ref()) {
            PayloadDisposition::Content => Ok(()),
            PayloadDisposition::Droppable => {
                if let Some(Payload::TypingSignal(ref signal)) = stored.message.payload
                    && !signal.context_id.trim().is_empty()
                {
                    match codec::decode_typing_state(signal.state) {
                        Some(TypingState::Started) => {
                            self.typing.started(
                                &signal.context_id,
                                sender_user_id,
                                sender_device_id,
                            );
                        }
                        Some(TypingState::Stopped) => {
                            self.typing.stopped(&signal.context_id, sender_device_id);
                        }
                        None => {
                            self.log(format!(
                                "TYPING with unspecified state from {sender_user_id}; ignored"
                            ));
                        }
                    }
                }
                Ok(())
            }
            PayloadDisposition::KitInternal => match stored.friend_follow_up {
                FriendFollowUp::None => Ok(()),
                FriendFollowUp::Sync => {
                    self.sync_friend_list().await;
                    Ok(())
                }
                FriendFollowUp::Accept => {
                    self.execute_pending_friend_reply(&PendingFriendReply {
                        envelope_id: envelope_id.to_owned(),
                        peer_user_id: sender_user_id.to_owned(),
                        action: FriendReplyAction::Accept,
                    })
                    .await
                }
                FriendFollowUp::ReplyAccept => {
                    self.execute_pending_friend_reply(&PendingFriendReply {
                        envelope_id: envelope_id.to_owned(),
                        peer_user_id: sender_user_id.to_owned(),
                        action: FriendReplyAction::ReplyAccept,
                    })
                    .await
                }
            },
        }
    }

    async fn execute_pending_friend_reply(
        &self,
        reply: &PendingFriendReply,
    ) -> Result<(), ObscuraError> {
        match reply.action {
            FriendReplyAction::Accept => {
                self.accept_friend(reply.peer_user_id.clone()).await?;
            }
            FriendReplyAction::ReplyAccept => {
                self.require_fresh_token().await?;
                self.send_friend_accept(&reply.peer_user_id).await?;
                self.log(format!(
                    "FRIEND_REQUEST from known peer {} (accepted); unchanged, acceptance replied",
                    reply.peer_user_id
                ));
            }
        }
        let env_id = reply.envelope_id.clone();
        self.db
            .write_tx(move |ctx| content_store::complete_pending_friend_reply(ctx.conn, &env_id))
            .await
    }

    fn acknowledge<F>(&self, id_bytes: Vec<u8>, envelope_id: &str, ack: F)
    where
        F: FnOnce(Vec<u8>) -> Result<(), ObscuraError>,
    {
        if let Err(e) = ack(id_bytes) {
            self.log(format!("RECV ack failed for {envelope_id}: {e}"));
            self.logger
                .ack_failed(envelope_id.to_owned(), e.to_string());
        }
        self.last_processed_at_ms
            .store((self.clock)(), Ordering::SeqCst);
        let next = self.processed_envelopes_rx.borrow().saturating_add(1);
        let _ = self.processed_envelopes_tx.send(next);
    }

    async fn complete_link_inner(
        &self,
        request: &LinkRequest,
        token: &CancellationToken,
    ) -> Result<(), ObscuraError> {
        self.auth.require_unprovisioned().await?;
        let envelope_bytes = self.await_approval(request, token).await?;
        let ephem_priv = PrivateKey::deserialize(&request.ephemeral_private_key)
            .map_err(|_| ObscuraError::link_failed("Invalid ephemeral key"))?;
        let bundle_bytes = link::open(&envelope_bytes, &ephem_priv)?;
        let bundle = LinkBundle::decode(&bundle_bytes[..])
            .map_err(|_| ObscuraError::protocol("Invalid link bundle"))?;

        if bundle.user_id != request.user_id {
            return Err(ObscuraError::protocol("Link bundle is for another account"));
        }
        if !is_uuid(&bundle.primary_device_id) {
            return Err(ObscuraError::protocol(
                "Invalid primary device in link bundle",
            ));
        }
        let identity = IdentityKeyPair::try_from(&bundle.identity_key_pair[..])
            .map_err(|_| ObscuraError::protocol("Invalid identity in link bundle"))?;

        let mut friends = Vec::with_capacity(bundle.friends.len());
        for rec in &bundle.friends {
            let f = codec::decode_friend(rec)
                .ok_or_else(|| ObscuraError::protocol("Invalid friend in link bundle"))?;
            friends.push(f);
        }
        let friend_list = FriendList {
            version: bundle.friend_list_version,
            friends,
        };

        let keys = prekeys::generate_provisioning_keys(identity, (self.clock)()).await?;
        self.auth
            .provision_linked(
                &request.user_id,
                &bundle.primary_device_id,
                &request.username,
                &request.device_name,
                keys,
                &request.session_id,
                move |ctx| friend_store::replace(ctx, &friend_list),
            )
            .await?;

        let post_provision_res: Result<(), ObscuraError> = async {
            if let Some(ref history) = bundle.history {
                self.restore_history_snapshot(history).await?;
            }
            self.connect().await
        }
        .await;

        self.auth.publish_authenticated();
        post_provision_res
    }

    async fn await_approval(
        &self,
        request: &LinkRequest,
        token: &CancellationToken,
    ) -> Result<Vec<u8>, ObscuraError> {
        while (self.clock)() / 1000 < request.expires_at {
            if token.is_cancelled() {
                return Err(ObscuraError::link_failed("Link cancelled"));
            }
            let fetch_fut = self.api.await_link_session(&request.session_id);
            let res = tokio::select! {
                _ = token.cancelled() => return Err(ObscuraError::link_failed("Link cancelled")),
                r = fetch_fut => r,
            };
            match res {
                Ok(Some(body)) => return Ok(body),
                Ok(None) => {}
                Err(ObscuraError::Http { status: 404, .. }) => {
                    return Err(ObscuraError::link_failed("Link session expired or unknown"));
                }
                Err(e) => return Err(e),
            }
            tokio::select! {
                _ = token.cancelled() => return Err(ObscuraError::link_failed("Link cancelled")),
                _ = tokio::time::sleep(Duration::from_millis(LINK_POLL_MS)) => {}
            }
        }
        Err(ObscuraError::link_failed("Link session expired"))
    }

    async fn upload_history_snapshot(&self) -> Result<Option<HistorySnapshot>, ObscuraError> {
        let Some(snapshot) = self.db.read(history_sync::export_snapshot).await? else {
            return Ok(None);
        };
        let uploaded = self
            .upload_attachment_bytes(&snapshot.encode_to_vec())
            .await?;
        Ok(Some(HistorySnapshot {
            attachment_id: uploaded.id,
            content_key: uploaded.content_key,
            nonce: uploaded.nonce,
        }))
    }

    async fn restore_history_snapshot(
        &self,
        history: &HistorySnapshot,
    ) -> Result<(), ObscuraError> {
        let plaintext = self
            .download_decrypted_attachment(
                &history.attachment_id,
                &history.content_key,
                &history.nonce,
            )
            .await?;
        let snapshot = EntrySnapshot::decode(&plaintext[..])
            .map_err(|_| ObscuraError::protocol("Invalid history snapshot"))?;
        self.db
            .write_tx(move |ctx| history_sync::import_snapshot(ctx.conn, &snapshot))
            .await
    }

    pub async fn upload_attachment_bytes(
        &self,
        plaintext: &[u8],
    ) -> Result<AttachmentUpload, ObscuraError> {
        self.require_fresh_token().await?;
        let encrypted = attachment::encrypt(plaintext)?;
        let id = self.api.upload_attachment(encrypted.ciphertext).await?;
        Ok(AttachmentUpload {
            id,
            content_key: encrypted.content_key,
            nonce: encrypted.nonce,
        })
    }

    pub async fn upload_attachment_path(
        &self,
        file_path: &str,
    ) -> Result<AttachmentUpload, ObscuraError> {
        self.require_fresh_token().await?;
        let plaintext = std::fs::read(file_path).map_err(|e| {
            ObscuraError::storage(format!("Failed to read capture file {file_path}: {e}"))
        })?;
        let encrypted = attachment::encrypt(&plaintext)?;

        let id = if let Some(ref cache_dir) = self.attachment_cache_dir {
            std::fs::create_dir_all(cache_dir).map_err(|e| {
                ObscuraError::storage(format!("Failed to create attachment cache dir: {e}"))
            })?;
            let tmp_path = cache_dir.join(format!("upload_{}.tmp", Uuid::new_v4()));
            std::fs::write(&tmp_path, &encrypted.ciphertext).map_err(|e| {
                ObscuraError::storage(format!("Failed to write encrypted upload temp file: {e}"))
            })?;
            let tmp_str = tmp_path.to_string_lossy().into_owned();
            let res = self.api.upload_attachment_file(&tmp_str).await;
            let _ = std::fs::remove_file(&tmp_path);
            res?
        } else {
            self.api.upload_attachment(encrypted.ciphertext).await?
        };

        Ok(AttachmentUpload {
            id,
            content_key: encrypted.content_key,
            nonce: encrypted.nonce,
        })
    }

    pub async fn download_decrypted_attachment(
        &self,
        id: &str,
        content_key: &[u8],
        nonce: &[u8],
    ) -> Result<Vec<u8>, ObscuraError> {
        self.require_fresh_token().await?;
        let ciphertext = if let Some(ref cache_dir) = self.attachment_cache_dir {
            let _ = std::fs::create_dir_all(cache_dir);
            let tmp_path = cache_dir.join(format!("download_{}.tmp", Uuid::new_v4()));
            let tmp_str = tmp_path.to_string_lossy().into_owned();
            let resp_bytes = self.api.fetch_attachment_to_file(id, &tmp_str).await;
            match resp_bytes {
                Ok(body) => {
                    let from_disk = std::fs::read(&tmp_path).ok().filter(|b| !b.is_empty());
                    let _ = std::fs::remove_file(&tmp_path);
                    from_disk.unwrap_or(body)
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(e);
                }
            }
        } else {
            self.api.fetch_attachment(id).await?
        };
        attachment::decrypt(&ciphertext, content_key, nonce)
    }

    pub async fn send_pix(
        &self,
        peer_user_id: &str,
        attachment: MediaAttachment,
        caption: &str,
        caption_meta: Option<&str>,
        display_duration: i32,
    ) -> Result<String, ObscuraError> {
        if peer_user_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("peerUserId must not be blank"));
        }
        let self_creds = self.require_fresh_token().await?;
        if peer_user_id == self_creds.user_id {
            return Err(ObscuraError::invalid_arg("Cannot message yourself"));
        }
        let sent_at = (self.clock)();
        let id = generate_entry_id("pix", sent_at);
        let item = ConversationItem::pix(
            id.clone(),
            peer_user_id.to_owned(),
            self_creds.user_id.clone(),
            sent_at,
            attachment,
            (!caption.is_empty()).then(|| caption.to_owned()),
            caption_meta.filter(|s| !s.is_empty()).map(str::to_owned),
            display_duration,
            None,
            false,
        );
        let item_for_db = item.clone();
        self.db
            .write_tx(move |ctx| content_store::insert_conversation(ctx.conn, &item_for_db))
            .await?;

        let accepted = self.accepted_friend_ids(&self_creds.user_id).await?;
        let peers: Vec<String> = if accepted.contains(peer_user_id) {
            vec![peer_user_id.to_owned()]
        } else {
            Vec::new()
        };
        let report = self
            .send_to_peers_and_self(&self_creds.user_id, &peers, &item.to_client_message())
            .await;
        if peers.is_empty()
            || !report
                .recipients
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
        {
            let id_clone = id.clone();
            self.db
                .write_tx(move |ctx| {
                    content_store::set_conversation_undelivered(ctx.conn, &id_clone, true)
                })
                .await?;
            return Err(send_failed(EntryModel::Pix, &report));
        }
        Ok(id)
    }

    pub async fn send_typing_in_context(
        &self,
        recipient_user_ids: &[String],
        context_id: &str,
        state: TypingState,
    ) -> Result<(), ObscuraError> {
        if context_id.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("contextId must not be blank"));
        }
        let self_creds = self.auth.require_credentials()?;
        if !self.typing.should_send(context_id, state, (self.clock)()) {
            return Ok(());
        }
        self.require_fresh_token().await?;
        let msg = ClientMessage {
            timestamp: (self.clock)().max(0) as u64,
            payload: Some(Payload::TypingSignal(TypingSignal {
                context_id: context_id.to_owned(),
                state: codec::encode_typing_state(state),
            })),
        };
        let mut peers = Vec::new();
        for r in recipient_user_ids {
            if r != &self_creds.user_id && !peers.contains(r) {
                peers.push(r.clone());
            }
        }
        let results = self.sender.send(&peers, &msg).await;
        for recipient in &peers {
            let rec_results: Vec<_> = results.iter().filter(|r| &r.user_id == recipient).collect();
            if !rec_results
                .iter()
                .any(|r| r.status == SubmissionStatus::Accepted)
            {
                let reasons = rec_results
                    .iter()
                    .map(|r| r.error.clone().unwrap_or_else(|| format!("{:?}", r.status)))
                    .collect::<Vec<_>>()
                    .join(", ");
                self.log(format!("TYPING not delivered to {recipient}: {reasons}"));
            }
        }
        Ok(())
    }

    pub async fn befriend(
        &self,
        target_user_id: &str,
        target_username: &str,
    ) -> Result<(), ObscuraError> {
        let self_creds = self.require_primary().await?;
        if target_user_id == self_creds.user_id {
            return Err(ObscuraError::invalid_arg("Cannot befriend yourself"));
        }
        let uid = target_user_id.to_owned();
        let uname = target_username.to_owned();
        let existing = self
            .db
            .write_tx(move |ctx| friend_store::prepare_request(ctx, &uid, &uname))
            .await?;

        match existing.as_ref().map(|f| f.status) {
            Some(FriendStatus::Accepted) => return Ok(()),
            Some(FriendStatus::PendingReceived) => {
                return self.accept_friend(target_user_id.to_owned()).await;
            }
            Some(FriendStatus::PendingSent) | None => {}
        }

        let req_msg = ClientMessage {
            timestamp: (self.clock)().max(0) as u64,
            payload: Some(Payload::FriendRequest(FriendRequest {
                username: self_creds.username,
            })),
        };
        if let Err(e) = self.sender.send_or_throw(target_user_id, &req_msg).await {
            if existing.is_none() {
                let uid = target_user_id.to_owned();
                let _ = self
                    .db
                    .write_tx(move |ctx| friend_store::remove_pending_request(ctx, &uid))
                    .await;
            }
            return Err(e);
        }
        if existing.is_none() {
            self.sync_friend_list().await;
        }
        Ok(())
    }

    async fn send_friend_accept(&self, user_id: &str) -> Result<(), ObscuraError> {
        let msg = ClientMessage {
            timestamp: (self.clock)().max(0) as u64,
            payload: Some(Payload::FriendAccept(FriendAccept {})),
        };
        self.sender.send_or_throw(user_id, &msg).await
    }

    async fn sync_friend_list(&self) {
        let res: Result<(), ObscuraError> = async {
            let self_creds = self.require_fresh_token().await?;
            let list = self.db.read(friend_store::list).await?;
            let msg = ClientMessage {
                timestamp: (self.clock)().max(0) as u64,
                payload: Some(Payload::FriendListSync(FriendListSync {
                    version: list.version,
                    friends: list.friends.iter().map(codec::encode_friend).collect(),
                })),
            };
            let results = self.sender.send_one(&self_creds.user_id, &msg).await;
            for r in results {
                if r.status != SubmissionStatus::Accepted {
                    self.log(format!(
                        "FRIEND_LIST_SYNC v{} not accepted by {:?}: {:?}",
                        list.version, r.device_id, r.error
                    ));
                }
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            self.log(format!("FRIEND_LIST_SYNC not sent: {e}"));
        }
    }

    async fn sync_prekeys(&self) {
        let _task_guard = self.session_task_mutex.lock().await;
        let session_gen = self.auth.generation();
        let res: Result<(), ObscuraError> = async {
            self.require_fresh_token().await?;
            if self.auth.generation() != session_gen {
                return Ok(());
            }
            let counts = self.api.fetch_pre_key_counts().await?;
            if self.auth.generation() != session_gen {
                return Ok(());
            }
            let now = (self.clock)();
            let refill = prekeys::prepare_refill(&self.db, counts, now).await?;
            if !refill.is_empty() {
                self.api.upload_pre_keys(&refill.to_upload()?).await?;
            }
            if self.auth.generation() != session_gen {
                return Ok(());
            }
            prekeys::confirm_refill(&self.db, &refill, (self.clock)()).await?;
            if !refill.is_empty() {
                self.log(format!(
                    "PREKEYS uploaded (counts were {} EC, {} Kyber)",
                    counts.one_time, counts.kyber
                ));
            }
            Ok(())
        }
        .await;
        if let Err(e) = res {
            self.logger.pre_key_sync_failed(e.to_string());
        }
    }

    pub fn request_prekey_sync(&self) {
        if self.auth.credentials().is_some() {
            let _ = self.prekey_sync_tx.send(());
        }
    }

    async fn try_connect(&self) -> bool {
        match self.connect().await {
            Ok(()) => true,
            Err(e) => {
                self.log(format!("PUSH connect failed: {e}"));
                false
            }
        }
    }

    async fn await_idle(&self, deadline: i64) {
        let mut rx = self.processed_envelopes_rx.clone();
        let mut seen = *rx.borrow_and_update();
        loop {
            let remaining = deadline - (self.clock)();
            if remaining <= 0 {
                return;
            }
            let wait_ms = remaining.min(PUSH_IDLE_MS) as u64;
            let changed = tokio::time::timeout(Duration::from_millis(wait_ms), rx.changed()).await;
            match changed {
                Ok(Ok(())) => {
                    let current = *rx.borrow_and_update();
                    if current > seen {
                        seen = current;
                    } else {
                        return;
                    }
                }
                _ => return,
            }
        }
    }

    async fn wipe_device_internal(&self, revoke: bool) -> Result<(), ObscuraError> {
        self.end_session(revoke, None, None).await?;
        self.db.wipe_all().await?;
        if let Some(ref dir) = self.attachment_cache_dir {
            attachment::purge_all_cached(dir);
        }
        Ok(())
    }

    async fn end_session(
        &self,
        revoke: bool,
        expected: Option<&Credentials>,
        expected_generation: Option<u64>,
    ) -> Result<(), ObscuraError> {
        let end_res = self.auth.end(expected, expected_generation);
        if self.auth.credentials().is_none() {
            self.gateway.disconnect();
            // Wait for any in-flight receive_envelope or sync_prekeys to settle before returning
            // (unless end_session was triggered from inside a 401 refresh during that task).
            if expected.is_none() {
                let _ = self.session_task_mutex.lock().await;
            }
            self.typing.clear();
        }
        let previous = end_res?;
        if expected.is_some() && previous.is_none() {
            return Ok(());
        }
        if revoke && let Some(ref prev) = previous {
            self.auth.revoke(prev).await;
        }
        self.log("SESSION ended");
        Ok(())
    }

    async fn require_fresh_token(&self) -> Result<Credentials, ObscuraError> {
        if self.auth.ensure_fresh_token().await? == TokenStatus::Rejected {
            return Err(ObscuraError::NotAuthenticated);
        }
        self.auth.require_credentials()
    }

    async fn require_primary(&self) -> Result<Credentials, ObscuraError> {
        let creds = self.require_fresh_token().await?;
        if !self.is_primary().await? {
            return Err(ObscuraError::NotPrimary);
        }
        Ok(creds)
    }

    async fn accepted_friend_ids(
        &self,
        self_user_id: &str,
    ) -> Result<HashSet<String>, ObscuraError> {
        let all = self.db.read(friend_store::get_all).await?;
        Ok(all
            .into_iter()
            .filter(|f| f.status == FriendStatus::Accepted && f.user_id != self_user_id)
            .map(|f| f.user_id)
            .collect())
    }

    async fn send_to_peers_and_self(
        &self,
        self_user_id: &str,
        peers: &[String],
        message: &ClientMessage,
    ) -> SendReport {
        let mut targets = Vec::new();
        for p in peers {
            if p != self_user_id && !targets.contains(p) {
                targets.push(p.clone());
            }
        }
        targets.push(self_user_id.to_owned());
        let results = self.sender.send(&targets, message).await;
        let (self_sync, recipients) = results.into_iter().partition(|r| r.user_id == self_user_id);
        SendReport {
            recipients,
            self_sync,
        }
    }

    pub fn log(&self, message: impl AsRef<str>) {
        append_log(
            &self.debug_log,
            &self.logger,
            (self.clock)(),
            message.as_ref(),
        );
    }
}

fn store_decrypted_in_tx(
    ctx: &mut DbContext<'_>,
    message: ClientMessage,
    sender_user_id: &str,
    sender_device_id: &str,
    envelope_id: &str,
    self_user_id: Option<&str>,
    now_ms: i64,
) -> Result<(StoredReceive, Vec<String>), ObscuraError> {
    let mut logs = Vec::new();
    match payload_disposition(message.payload.as_ref()) {
        PayloadDisposition::Content => {
            if !content_store::record_envelope(ctx.conn, envelope_id)? {
                logs.push(format!("RECV duplicate envelope {envelope_id}"));
                return Ok((
                    StoredReceive {
                        message,
                        friend_follow_up: FriendFollowUp::None,
                    },
                    logs,
                ));
            }
            let sent_at = clamp_future_timestamp(message.timestamp, now_ms);
            match &message.payload {
                Some(Payload::DirectMessage(dm)) => {
                    let Some(peer) =
                        resolve_peer_user_id(sender_user_id, &dm.peer_user_id, self_user_id)
                    else {
                        logs.push(format!(
                            "RECV DIRECT_MESSAGE with blank id or invalid peer from {sender_user_id}; ignored"
                        ));
                        return Ok((
                            StoredReceive {
                                message,
                                friend_follow_up: FriendFollowUp::None,
                            },
                            logs,
                        ));
                    };
                    if dm.id.trim().is_empty() {
                        logs.push(format!(
                            "RECV DIRECT_MESSAGE with blank id or invalid peer from {sender_user_id}; ignored"
                        ));
                    } else if content_store::can_insert_conversation(ctx.conn, &dm.id)? {
                        let item = ConversationItem::message(
                            dm.id.clone(),
                            peer,
                            sender_user_id.to_owned(),
                            sent_at,
                            dm.content.clone(),
                            None,
                            false,
                        );
                        content_store::insert_conversation(ctx.conn, &item)?;
                        ctx.push_effect(PostCommitEffect::EntryInboxed(EntryModel::DirectMessage));
                    }
                }
                Some(Payload::Pix(pix)) => {
                    let peer =
                        resolve_peer_user_id(sender_user_id, &pix.peer_user_id, self_user_id);
                    let att = pix
                        .attachment
                        .as_ref()
                        .and_then(MediaAttachment::from_proto);
                    let (Some(peer), Some(att)) = (peer, att) else {
                        logs.push(format!(
                            "RECV PIX with invalid fields from {sender_user_id}; ignored"
                        ));
                        return Ok((
                            StoredReceive {
                                message,
                                friend_follow_up: FriendFollowUp::None,
                            },
                            logs,
                        ));
                    };
                    if pix.id.trim().is_empty() {
                        logs.push(format!(
                            "RECV PIX with invalid fields from {sender_user_id}; ignored"
                        ));
                    } else if content_store::can_insert_conversation(ctx.conn, &pix.id)? {
                        let item = ConversationItem::pix(
                            pix.id.clone(),
                            peer,
                            sender_user_id.to_owned(),
                            sent_at,
                            att,
                            (!pix.caption.is_empty()).then(|| pix.caption.clone()),
                            (!pix.caption_meta.is_empty()).then(|| pix.caption_meta.clone()),
                            pix.display_duration_secs as i32,
                            None,
                            false,
                        );
                        content_store::insert_conversation(ctx.conn, &item)?;
                        ctx.push_effect(PostCommitEffect::EntryInboxed(EntryModel::Pix));
                    }
                }
                Some(Payload::SeenReceipt(sr)) => {
                    let peer = resolve_peer_user_id(sender_user_id, &sr.peer_user_id, self_user_id);
                    if sr.entry_id.trim().is_empty() || peer.is_none() {
                        logs.push(format!(
                            "RECV SEEN_RECEIPT with blank entryId or invalid peer from {sender_user_id}; ignored"
                        ));
                    } else if let Some(row) =
                        content_store::get_conversation(ctx.conn, &sr.entry_id)?
                        && Some(row.peer_user_id.as_str()) == peer.as_deref()
                        && row.author_user_id != sender_user_id
                        && row.viewed_at.is_none()
                    {
                        let raw_viewed = i64::try_from(sr.viewed_at).unwrap_or(sent_at).max(0);
                        let viewed_at = raw_viewed.min(sent_at);
                        content_store::mark_conversation_viewed(
                            ctx.conn,
                            &sr.entry_id,
                            viewed_at,
                            expires_at(row.sent_at, Some(viewed_at)),
                        )?;
                        ctx.push_effect(PostCommitEffect::EntryInboxed(EntryModel::Seen));
                    }
                }
                Some(Payload::Story(st)) => {
                    if st.id.trim().is_empty() {
                        logs.push(format!(
                            "RECV STORY with blank id from {sender_user_id}; ignored"
                        ));
                    } else if content_store::can_insert_story(ctx.conn, &st.id)? {
                        let att = st.attachment.as_ref().and_then(MediaAttachment::from_proto);
                        let item = StoryItem::new(
                            st.id.clone(),
                            sender_user_id.to_owned(),
                            sent_at,
                            st.content.clone(),
                            att,
                            (!st.caption_meta.is_empty()).then(|| st.caption_meta.clone()),
                            false,
                        );
                        content_store::insert_story(ctx.conn, &item)?;
                        ctx.push_effect(PostCommitEffect::EntryInboxed(EntryModel::Story));
                    }
                }
                Some(Payload::Profile(pr)) => {
                    let updated = content_store::upsert_profile_if_newer(
                        ctx.conn,
                        &ProfileItem {
                            user_id: sender_user_id.to_owned(),
                            author_device_id: sender_device_id.to_owned(),
                            updated_at: sent_at,
                            display_name: pr.display_name.clone(),
                            bio: pr.bio.clone(),
                            undelivered: false,
                        },
                    )?;
                    if updated {
                        ctx.push_effect(PostCommitEffect::EntryInboxed(EntryModel::Profile));
                    }
                }
                _ => {}
            }
            Ok((
                StoredReceive {
                    message,
                    friend_follow_up: FriendFollowUp::None,
                },
                logs,
            ))
        }
        PayloadDisposition::KitInternal => {
            let follow_up = apply_friend_message_in_tx(
                ctx,
                &message,
                sender_user_id,
                sender_device_id,
                envelope_id,
                self_user_id,
                &mut logs,
            )?;
            Ok((
                StoredReceive {
                    message,
                    friend_follow_up: follow_up,
                },
                logs,
            ))
        }
        PayloadDisposition::Droppable => {
            let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
            if !matches!(message.payload, Some(Payload::TypingSignal(_))) {
                logs.push(format!(
                    "RECV unknown client message arm from {sender_user_id}; ignored"
                ));
            }
            Ok((
                StoredReceive {
                    message,
                    friend_follow_up: FriendFollowUp::None,
                },
                logs,
            ))
        }
    }
}

fn apply_friend_message_in_tx(
    ctx: &mut DbContext<'_>,
    message: &ClientMessage,
    sender_user_id: &str,
    sender_device_id: &str,
    envelope_id: &str,
    self_user_id: Option<&str>,
    logs: &mut Vec<String>,
) -> Result<FriendFollowUp, ObscuraError> {
    let local = device_store::get_local(ctx.conn)?;
    if let Some(Payload::FriendListSync(ref sync)) = message.payload {
        apply_friend_list_sync_in_tx(
            ctx,
            sync,
            local.as_ref(),
            sender_user_id,
            sender_device_id,
            self_user_id,
            logs,
        )?;
        let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
        return Ok(FriendFollowUp::None);
    }

    if !local.as_ref().is_some_and(LocalDevice::is_primary) {
        let arm = codec::kind(message.payload.as_ref());
        logs.push(format!(
            "{arm} from {sender_user_id} on a linked device; unchanged"
        ));
        let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
        return Ok(FriendFollowUp::None);
    }

    let existing = friend_store::get(ctx.conn, sender_user_id)?;
    match &message.payload {
        Some(Payload::FriendRequest(req)) => match existing.as_ref().map(|f| f.status) {
            None => {
                friend_store::add(
                    ctx,
                    sender_user_id,
                    &req.username,
                    FriendStatus::PendingReceived,
                )?;
                let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
                Ok(FriendFollowUp::Sync)
            }
            Some(FriendStatus::PendingSent) => {
                content_store::put_pending_friend_reply(
                    ctx.conn,
                    envelope_id,
                    sender_user_id,
                    FriendReplyAction::Accept,
                )?;
                Ok(FriendFollowUp::Accept)
            }
            Some(FriendStatus::Accepted) => {
                content_store::put_pending_friend_reply(
                    ctx.conn,
                    envelope_id,
                    sender_user_id,
                    FriendReplyAction::ReplyAccept,
                )?;
                Ok(FriendFollowUp::ReplyAccept)
            }
            Some(FriendStatus::PendingReceived) => {
                logs.push(format!(
                    "FRIEND_REQUEST from known peer {sender_user_id} (pending_received); unchanged"
                ));
                let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
                Ok(FriendFollowUp::None)
            }
        },
        Some(Payload::FriendAccept(_)) => {
            if existing.as_ref().map(|f| f.status) == Some(FriendStatus::PendingSent) {
                friend_store::update_status(ctx, sender_user_id, FriendStatus::Accepted)?;
                let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
                Ok(FriendFollowUp::Sync)
            } else {
                logs.push(format!(
                    "FRIEND_ACCEPT from {sender_user_id} without a pending request; ignored"
                ));
                let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
                Ok(FriendFollowUp::None)
            }
        }
        _ => {
            let _ = content_store::record_envelope(ctx.conn, envelope_id)?;
            Ok(FriendFollowUp::None)
        }
    }
}

fn apply_friend_list_sync_in_tx(
    ctx: &mut DbContext<'_>,
    sync: &client::FriendListSync,
    local: Option<&LocalDevice>,
    sender_user_id: &str,
    sender_device_id: &str,
    self_user_id: Option<&str>,
    logs: &mut Vec<String>,
) -> Result<(), ObscuraError> {
    let current_version = friend_store::version(ctx.conn)?;
    let decoded_records: Vec<Option<Friend>> =
        sync.friends.iter().map(codec::decode_friend).collect();
    let reason = if local.is_none_or(LocalDevice::is_primary) {
        Some("this device is not a linked device".to_owned())
    } else if Some(sender_user_id) != self_user_id
        || sender_device_id != local.unwrap().primary_device_id
    {
        Some("not from this account's primary".to_owned())
    } else if sync.version <= current_version {
        Some(format!("version {} is not newer", sync.version))
    } else if decoded_records.iter().any(Option::is_none) {
        Some("it has an invalid friend record".to_owned())
    } else {
        None
    };

    if let Some(reason) = reason {
        logs.push(format!(
            "FRIEND_LIST_SYNC from {sender_user_id} ignored: {reason}"
        ));
        return Ok(());
    }

    let friends: Vec<Friend> = decoded_records.into_iter().flatten().collect();
    friend_store::replace(
        ctx,
        &FriendList {
            version: sync.version,
            friends,
        },
    )
}

fn resolve_peer_user_id(
    sender_user_id: &str,
    claimed_peer_user_id: &str,
    self_user_id: Option<&str>,
) -> Option<String> {
    if sender_user_id.trim().is_empty() {
        return None;
    }
    if Some(sender_user_id) == self_user_id {
        if !claimed_peer_user_id.trim().is_empty() && Some(claimed_peer_user_id) != self_user_id {
            Some(claimed_peer_user_id.to_owned())
        } else {
            None
        }
    } else if !claimed_peer_user_id.trim().is_empty()
        && Some(claimed_peer_user_id) != self_user_id
        && claimed_peer_user_id != sender_user_id
    {
        None
    } else {
        Some(sender_user_id.to_owned())
    }
}

fn send_failed(model: EntryModel, report: &SendReport) -> ObscuraError {
    let reasons: Vec<String> = report
        .recipients
        .iter()
        .map(|r| {
            r.error
                .clone()
                .unwrap_or_else(|| format!("{:?}", r.status).to_ascii_lowercase())
        })
        .collect();
    if reasons.is_empty() {
        ObscuraError::send_failed(format!("{} reached none of its recipients", model.as_str()))
    } else {
        ObscuraError::send_failed(format!(
            "{} reached none of its recipients: {}",
            model.as_str(),
            reasons.join("; ")
        ))
    }
}

fn generate_entry_id(prefix: &str, now_ms: i64) -> String {
    let mut val: u64 = rand::rng().random();
    const BASE36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut chars = ['0'; 8];
    for c in chars.iter_mut().rev() {
        *c = BASE36[(val % 36) as usize] as char;
        val /= 36;
    }
    let token: String = chars.iter().collect();
    format!("{prefix}_{now_ms}_{token}")
}

fn append_log(
    debug_log: &Mutex<VecDeque<String>>,
    logger: &Arc<dyn ObscuraLogger>,
    now_ms: i64,
    message: &str,
) {
    let total_millis = now_ms.rem_euclid(86_400_000);
    let hours = total_millis / 3_600_000;
    let minutes = (total_millis % 3_600_000) / 60_000;
    let seconds = (total_millis % 60_000) / 1_000;
    let millis = total_millis % 1_000;
    let line = format!("[{hours:02}:{minutes:02}:{seconds:02}.{millis:03}] {message}");
    {
        let mut log = debug_log.lock().unwrap_or_else(|p| p.into_inner());
        if log.len() >= DEBUG_LOG_SIZE {
            log.pop_back();
        }
        log.push_front(line);
    }
    logger.log(message.to_owned());
}
