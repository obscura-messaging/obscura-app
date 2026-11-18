use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::TokenStatus;
use crate::crypto::prekeys::{DeviceKeysJson, PreKeyCounts, PreKeyUploadJson};
use crate::error::ObscuraError;
use crate::network::transport::{HttpRequest, Transport};
use crate::wire::uuid_codec::is_uuid;

pub const MAX_RETRIES: u32 = 2;
pub const MAX_RETRY_AFTER_S: i64 = 10;

const JSON_CONTENT_TYPE: &str = "application/json";
const PROTOBUF_CONTENT_TYPE: &str = "application/x-protobuf";
const OCTET_CONTENT_TYPE: &str = "application/octet-stream";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthResponse {
    pub token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user_id: String,
    pub device_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthResponse {
    #[serde(default)]
    token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    expires_at: i64,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    device_id: String,
}

impl AuthResponse {
    pub fn from_json(bytes: &[u8]) -> Result<Self, ObscuraError> {
        let raw: RawAuthResponse = serde_json::from_slice(bytes)
            .map_err(|e| ObscuraError::protocol(format!("Invalid auth response: {e}")))?;
        if raw.token.trim().is_empty()
            || raw.refresh_token.trim().is_empty()
            || raw.expires_at <= 0
            || !is_uuid(&raw.user_id)
            || !is_uuid(&raw.device_id)
        {
            return Err(ObscuraError::protocol("Invalid auth response"));
        }
        Ok(Self {
            token: raw.token,
            refresh_token: raw.refresh_token,
            expires_at: raw.expires_at,
            user_id: raw.user_id,
            device_id: raw.device_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnDevice {
    pub device_id: String,
    pub name: Option<String>,
    pub is_primary: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOwnDevice {
    device_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    is_primary: bool,
}

#[derive(Deserialize)]
struct RawDevicesWrapper {
    devices: Vec<RawOwnDevice>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkSession {
    pub id: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: i64,
}

#[derive(Clone, PartialEq, Eq)]
enum Auth {
    None,
    Token(String),
    Session,
}

pub type RefreshCallback = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<TokenStatus, ObscuraError>> + Send>>
        + Send
        + Sync,
>;
pub type TokenGetter = Arc<dyn Fn() -> Option<String> + Send + Sync>;

#[derive(Clone)]
pub struct APIClient {
    base_url: String,
    transport: Arc<dyn Transport>,
    refresh: RefreshCallback,
    token: TokenGetter,
}

impl APIClient {
    pub fn new(
        base_url: &str,
        transport: Arc<dyn Transport>,
        refresh: RefreshCallback,
        token: TokenGetter,
    ) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            transport,
            refresh,
            token,
        }
    }

    pub async fn register_user(
        &self,
        username: &str,
        password: &str,
        name: &str,
        keys: &DeviceKeysJson,
    ) -> Result<AuthResponse, ObscuraError> {
        let mut body = serde_json::to_value(keys)
            .map_err(|e| ObscuraError::protocol(format!("Failed to serialize device keys: {e}")))?;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("username".to_owned(), Value::String(username.to_owned()));
            obj.insert("password".to_owned(), Value::String(password.to_owned()));
            obj.insert("name".to_owned(), Value::String(name.to_owned()));
        }
        let bytes = self
            .send_json("POST", "/v1/users", &body, Auth::None)
            .await?;
        AuthResponse::from_json(&bytes)
    }

    pub async fn login(
        &self,
        username: &str,
        password: &str,
        device_id: &str,
    ) -> Result<AuthResponse, ObscuraError> {
        let body = json!({
            "username": username,
            "password": password,
            "deviceId": device_id,
        });
        let bytes = self
            .send_json("POST", "/v1/session", &body, Auth::None)
            .await?;
        AuthResponse::from_json(&bytes)
    }

    pub async fn reset_account(
        &self,
        username: &str,
        password: &str,
        name: &str,
        keys: &DeviceKeysJson,
    ) -> Result<AuthResponse, ObscuraError> {
        let mut body = serde_json::to_value(keys)
            .map_err(|e| ObscuraError::protocol(format!("Failed to serialize device keys: {e}")))?;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("username".to_owned(), Value::String(username.to_owned()));
            obj.insert("password".to_owned(), Value::String(password.to_owned()));
            obj.insert("name".to_owned(), Value::String(name.to_owned()));
        }
        let bytes = self
            .send_json("POST", "/v1/users/reset", &body, Auth::None)
            .await?;
        AuthResponse::from_json(&bytes)
    }

    pub async fn provision_device(
        &self,
        name: &str,
        keys: &DeviceKeysJson,
        link_session_id: &str,
    ) -> Result<AuthResponse, ObscuraError> {
        let mut body = serde_json::to_value(keys)
            .map_err(|e| ObscuraError::protocol(format!("Failed to serialize device keys: {e}")))?;
        if let Some(obj) = body.as_object_mut() {
            obj.insert("name".to_owned(), Value::String(name.to_owned()));
            obj.insert(
                "linkSessionId".to_owned(),
                Value::String(link_session_id.to_owned()),
            );
        }
        let bytes = self
            .send_json("POST", "/v1/devices", &body, Auth::None)
            .await?;
        AuthResponse::from_json(&bytes)
    }

    pub async fn refresh_session(&self, refresh_token: &str) -> Result<AuthResponse, ObscuraError> {
        let body = json!({ "refreshToken": refresh_token });
        let bytes = self
            .send_json("POST", "/v1/session/refresh", &body, Auth::None)
            .await?;
        AuthResponse::from_json(&bytes)
    }

    pub async fn logout(&self, bearer: &str) -> Result<(), ObscuraError> {
        self.send(
            "DELETE",
            "/v1/session",
            None,
            None,
            None,
            Auth::Token(bearer.to_owned()),
            &[],
        )
        .await?;
        Ok(())
    }

    pub async fn register_push_token(&self, push_token: &str) -> Result<(), ObscuraError> {
        let body = json!({ "token": push_token });
        self.send_json("PUT", "/v1/push-token", &body, Auth::Session)
            .await?;
        Ok(())
    }

    pub async fn upload_pre_keys(&self, keys: &PreKeyUploadJson) -> Result<(), ObscuraError> {
        let body = serde_json::to_value(keys)
            .map_err(|e| ObscuraError::protocol(format!("Failed to serialize prekeys: {e}")))?;
        self.send_json("POST", "/v1/keys", &body, Auth::Session)
            .await?;
        Ok(())
    }

    pub async fn fetch_pre_key_counts(&self) -> Result<PreKeyCounts, ObscuraError> {
        let bytes = self
            .send("GET", "/v1/keys", None, None, None, Auth::Session, &[])
            .await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| ObscuraError::protocol(format!("Invalid JSON response for /v1/keys: {e}")))
    }

    pub async fn fetch_pre_key_bundles(&self, user_id: &str) -> Result<Vec<Value>, ObscuraError> {
        let path = format!("/v1/keys/{}", url_encode(user_id));
        let bytes = self
            .send("GET", &path, None, None, None, Auth::Session, &[])
            .await?;
        let val: Value = serde_json::from_slice(&bytes).map_err(|e| {
            ObscuraError::protocol(format!("Invalid JSON response for /v1/keys: {e}"))
        })?;
        let bundles = val
            .get("bundles")
            .and_then(Value::as_array)
            .ok_or_else(|| ObscuraError::protocol("Invalid JSON response for /v1/keys"))?;
        Ok(bundles.clone())
    }

    pub async fn fetch_pre_key_bundle(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<Value, ObscuraError> {
        let path = format!(
            "/v1/keys/{}/devices/{}",
            url_encode(user_id),
            url_encode(device_id)
        );
        let bytes = self
            .send("GET", &path, None, None, None, Auth::Session, &[])
            .await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| ObscuraError::protocol(format!("Invalid JSON response for /v1/keys: {e}")))
    }

    pub async fn fetch_own_devices(&self) -> Result<Vec<OwnDevice>, ObscuraError> {
        let bytes = self
            .send("GET", "/v1/devices", None, None, None, Auth::Session, &[])
            .await?;
        let wrapper: RawDevicesWrapper = serde_json::from_slice(&bytes).map_err(|e| {
            ObscuraError::protocol(format!("Invalid JSON response for /v1/devices: {e}"))
        })?;
        let list: Vec<OwnDevice> = wrapper
            .devices
            .into_iter()
            .map(|d| OwnDevice {
                device_id: d.device_id,
                name: d.name,
                is_primary: d.is_primary,
            })
            .collect();
        let mut seen = std::collections::HashSet::new();
        let mut primary_count = 0usize;
        for d in &list {
            if !is_uuid(&d.device_id) || !seen.insert(d.device_id.clone()) {
                return Err(ObscuraError::protocol("Invalid device list"));
            }
            if d.is_primary {
                primary_count += 1;
            }
        }
        if primary_count > 1 {
            return Err(ObscuraError::protocol("Invalid device list"));
        }
        Ok(list)
    }

    pub async fn delete_device(&self, device_id: &str) -> Result<(), ObscuraError> {
        let path = format!("/v1/devices/{}", url_encode(device_id));
        self.send("DELETE", &path, None, None, None, Auth::Session, &[])
            .await?;
        Ok(())
    }

    pub async fn create_link_session(
        &self,
        username: &str,
        password: &str,
    ) -> Result<LinkSession, ObscuraError> {
        let body = json!({ "username": username, "password": password });
        let bytes = self
            .send_json("POST", "/v1/link-sessions", &body, Auth::None)
            .await?;
        let session: LinkSession = serde_json::from_slice(&bytes)
            .map_err(|_| ObscuraError::protocol("Invalid link session"))?;
        if session.id.trim().is_empty() || !is_uuid(&session.user_id) || session.expires_at <= 0 {
            return Err(ObscuraError::protocol("Invalid link session"));
        }
        Ok(session)
    }

    pub async fn approve_link_session(&self, id: &str, body: Vec<u8>) -> Result<(), ObscuraError> {
        let path = format!("/v1/link-sessions/{}", url_encode(id));
        self.send(
            "PUT",
            &path,
            Some(body),
            None,
            None,
            Auth::Session,
            &[("Content-Type", OCTET_CONTENT_TYPE)],
        )
        .await?;
        Ok(())
    }

    pub async fn await_link_session(&self, id: &str) -> Result<Option<Vec<u8>>, ObscuraError> {
        let path = format!("/v1/link-sessions/{}", url_encode(id));
        let (status, bytes) = self
            .exchange("GET", &path, None, None, None, Auth::None, &[])
            .await?;
        if status == 204 {
            Ok(None)
        } else {
            Ok(Some(bytes))
        }
    }

    pub async fn send_message(&self, protobuf: Vec<u8>) -> Result<Vec<u8>, ObscuraError> {
        let idempotency_key = Uuid::new_v4().to_string();
        self.send(
            "POST",
            "/v1/messages",
            Some(protobuf),
            None,
            None,
            Auth::Session,
            &[
                ("Content-Type", PROTOBUF_CONTENT_TYPE),
                ("Idempotency-Key", &idempotency_key),
            ],
        )
        .await
    }

    pub async fn upload_attachment(&self, blob: Vec<u8>) -> Result<String, ObscuraError> {
        let bytes = self
            .send(
                "POST",
                "/v1/attachments",
                Some(blob),
                None,
                None,
                Auth::Session,
                &[("Content-Type", OCTET_CONTENT_TYPE)],
            )
            .await?;
        parse_attachment_id(&bytes)
    }

    pub async fn upload_attachment_file(&self, file_path: &str) -> Result<String, ObscuraError> {
        let bytes = self
            .send(
                "POST",
                "/v1/attachments",
                None,
                Some(file_path.to_owned()),
                None,
                Auth::Session,
                &[("Content-Type", OCTET_CONTENT_TYPE)],
            )
            .await?;
        parse_attachment_id(&bytes)
    }

    pub async fn fetch_attachment(&self, id: &str) -> Result<Vec<u8>, ObscuraError> {
        let path = format!("/v1/attachments/{}", url_encode(id));
        self.send("GET", &path, None, None, None, Auth::Session, &[])
            .await
    }

    pub async fn fetch_attachment_to_file(
        &self,
        id: &str,
        response_file_path: &str,
    ) -> Result<Vec<u8>, ObscuraError> {
        let path = format!("/v1/attachments/{}", url_encode(id));
        self.send(
            "GET",
            &path,
            None,
            None,
            Some(response_file_path.to_owned()),
            Auth::Session,
            &[],
        )
        .await
    }

    pub async fn fetch_gateway_ticket(&self) -> Result<String, ObscuraError> {
        let bytes = self
            .send_json("POST", "/v1/gateway/ticket", &json!({}), Auth::Session)
            .await?;
        let val: Value = serde_json::from_slice(&bytes).map_err(|e| {
            ObscuraError::protocol(format!("Invalid JSON response for /v1/gateway/ticket: {e}"))
        })?;
        let ticket = val
            .get("ticket")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| ObscuraError::protocol("Invalid gateway ticket response"))?;
        Ok(ticket.to_owned())
    }

    pub fn gateway_url(&self, ticket: &str) -> String {
        let ws_base = if let Some(rest) = self.base_url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.base_url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.base_url.clone()
        };
        format!("{ws_base}/v1/gateway?ticket={}", url_encode(ticket))
    }

    async fn send_json(
        &self,
        method: &str,
        path: &str,
        body: &Value,
        auth: Auth,
    ) -> Result<Vec<u8>, ObscuraError> {
        let bytes = serde_json::to_vec(body)
            .map_err(|e| ObscuraError::protocol(format!("Failed to serialize JSON: {e}")))?;
        self.send(
            method,
            path,
            Some(bytes),
            None,
            None,
            auth,
            &[("Content-Type", JSON_CONTENT_TYPE)],
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        body_file_path: Option<String>,
        response_file_path: Option<String>,
        auth: Auth,
        extra_headers: &[(&str, &str)],
    ) -> Result<Vec<u8>, ObscuraError> {
        Ok(self
            .exchange(
                method,
                path,
                body,
                body_file_path,
                response_file_path,
                auth,
                extra_headers,
            )
            .await?
            .1)
    }

    #[allow(clippy::too_many_arguments)]
    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<Vec<u8>>,
        body_file_path: Option<String>,
        response_file_path: Option<String>,
        auth: Auth,
        extra_headers: &[(&str, &str)],
    ) -> Result<(u16, Vec<u8>), ObscuraError> {
        let mut retries = 0u32;
        let mut refreshed = false;

        loop {
            let bearer = match &auth {
                Auth::None => None,
                Auth::Token(val) => Some(val.clone()),
                Auth::Session => Some((self.token)().ok_or(ObscuraError::NotAuthenticated)?),
            };
            let mut headers = HashMap::new();
            if let Some(token) = bearer {
                headers.insert("Authorization".to_owned(), format!("Bearer {token}"));
            }
            for (k, v) in extra_headers {
                headers.insert((*k).to_owned(), (*v).to_owned());
            }

            let req = HttpRequest {
                method: method.to_owned(),
                url: format!("{}{path}", self.base_url),
                headers,
                body: body.clone(),
                body_file_path: body_file_path.clone(),
                response_file_path: response_file_path.clone(),
            };
            let resp = self.transport.execute(req).await?;
            if (200..=299).contains(&resp.status) {
                return Ok((resp.status, resp.body));
            }
            if resp.status == 401 && auth == Auth::Session && !refreshed {
                refreshed = true;
                match (self.refresh)().await? {
                    TokenStatus::Rejected => return Err(ObscuraError::NotAuthenticated),
                    TokenStatus::Fresh => continue,
                    TokenStatus::Unavailable => {}
                }
            }
            let wait_ms = retry_after_ms(resp.retry_after.as_deref());
            if !matches!(resp.status, 429 | 503) || retries == MAX_RETRIES || wait_ms.is_none() {
                return Err(ObscuraError::Http {
                    status: resp.status,
                    body: String::from_utf8_lossy(&resp.body).into_owned(),
                });
            }
            retries += 1;
            tokio::time::sleep(Duration::from_millis(wait_ms.unwrap())).await;
        }
    }
}

pub fn retry_after_ms(header: Option<&str>) -> Option<u64> {
    let seconds = header
        .map(str::trim)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(1)
        .max(1);
    if seconds > MAX_RETRY_AFTER_S {
        None
    } else {
        Some((seconds as u64) * 1000)
    }
}

fn parse_attachment_id(bytes: &[u8]) -> Result<String, ObscuraError> {
    let val: Value = serde_json::from_slice(bytes).map_err(|e| {
        ObscuraError::protocol(format!("Invalid JSON response for /v1/attachments: {e}"))
    })?;
    let id = val
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ObscuraError::protocol("Invalid attachment response"))?;
    Ok(id.to_owned())
}

pub fn url_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}
