use std::collections::HashMap;
use std::sync::{Arc, Weak};

use crate::error::ObscuraError;
use crate::network::gateway::GatewayInner;
use crate::types::{AuthState, ConnectionState, EntryModel};

#[uniffi::export(with_foreign)]
pub trait SessionStorage: Send + Sync {
    fn save(&self, data: HashMap<String, String>) -> Result<(), ObscuraError>;
    fn load(&self) -> Result<Option<HashMap<String, String>>, ObscuraError>;
    fn clear(&self) -> Result<(), ObscuraError>;
}

#[uniffi::export(with_foreign)]
pub trait ObscuraLogger: Send + Sync {
    fn log(&self, message: String);
    fn decrypt_failed(&self, source_user_id: String, reason: String);
    fn ack_failed(&self, envelope_id: String, reason: String);
    fn token_refresh_failed(&self, attempt: i32, reason: String);
    fn pre_key_sync_failed(&self, reason: String);
    fn identity_changed(&self, user_id: String);
    fn session_establish_failed(&self, user_id: String, reason: String);
    fn database_error(&self, store: String, operation: String, reason: String);
}

#[uniffi::export(with_foreign)]
pub trait ClientEventListener: Send + Sync {
    fn on_connection_state_changed(&self, state: ConnectionState);
    fn on_auth_state_changed(&self, state: AuthState);
    fn on_friends_changed(&self);
    fn on_message_received(&self, model: EntryModel);
    fn on_peer_typing_changed(&self, peer_user_id: String, is_typing: bool);
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Vec<u8>>,
    pub body_file_path: Option<String>,
    pub response_file_path: Option<String>,
}

#[derive(uniffi::Record, Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub retry_after: Option<String>,
}

#[uniffi::export(with_foreign)]
pub trait WebSocketHandle: Send + Sync {
    fn send(&self, bytes: Vec<u8>) -> Result<(), ObscuraError>;
    fn close_socket(&self);
}

#[uniffi::export(with_foreign)]
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, ObscuraError>;
    fn open_websocket(
        &self,
        url: String,
        sink: Arc<WebSocketSink>,
    ) -> Result<Arc<dyn WebSocketHandle>, ObscuraError>;
}

#[derive(uniffi::Object)]
pub struct WebSocketSink {
    pub(crate) gateway: Weak<GatewayInner>,
    pub(crate) generation: u64,
}

impl WebSocketSink {
    pub(crate) fn new(gateway: Weak<GatewayInner>, generation: u64) -> Self {
        Self {
            gateway,
            generation,
        }
    }
}

#[uniffi::export]
impl WebSocketSink {
    pub fn on_open(&self) {
        if let Some(gw) = self.gateway.upgrade() {
            gw.on_open(self.generation);
        }
    }

    pub fn on_binary(&self, bytes: Vec<u8>) {
        if let Some(gw) = self.gateway.upgrade() {
            gw.on_binary(self.generation, bytes);
        }
    }

    pub fn on_text(&self, text: String) {
        if let Some(gw) = self.gateway.upgrade() {
            gw.on_text(self.generation, text);
        }
    }

    pub fn on_closed(&self, reason: String) {
        if let Some(gw) = self.gateway.upgrade() {
            gw.on_closed(self.generation, reason);
        }
    }
}
