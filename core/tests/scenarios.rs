use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use obscura_core::crypto::prekeys::{
    DeviceKeysJson, KyberPreKeyJson, OneTimePreKeyJson, PreKeyCounts, PreKeyUploadJson,
    SignedPreKeyJson,
};
use obscura_core::error::ObscuraError;
use obscura_core::network::transport::{
    ClientEventListener, HttpRequest, HttpResponse, ObscuraLogger, SessionStorage, Transport,
    WebSocketHandle, WebSocketSink,
};
use obscura_core::proto::server::{
    Envelope, EnvelopeBatch, SendMessageRequest, SendMessageResponse, WebSocketFrame,
    send_message_response, web_socket_frame,
};
use obscura_core::types::{
    AuthState, ConnectionState, ConversationKind, EntryModel, FriendStatus, LoginScenario,
    MediaType, ObscuraClientConfig,
};
use obscura_core::wire::uuid_codec::{uuid_string, uuid_to_bytes};
use obscura_core::{ObscuraClient, link_code_device_name};
use prost::Message as _;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Default)]
struct MemorySessionStorage {
    data: Mutex<Option<HashMap<String, String>>>,
}

impl SessionStorage for MemorySessionStorage {
    fn save(&self, data: HashMap<String, String>) -> Result<(), ObscuraError> {
        *self.data.lock().unwrap() = Some(data);
        Ok(())
    }

    fn load(&self) -> Result<Option<HashMap<String, String>>, ObscuraError> {
        Ok(self.data.lock().unwrap().clone())
    }

    fn clear(&self) -> Result<(), ObscuraError> {
        *self.data.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct TestLogger {
    pub identity_changes: Mutex<Vec<String>>,
    pub decrypt_failures: Mutex<Vec<(String, String)>>,
    pub token_refresh_failures: Mutex<Vec<(i32, String)>>,
}

impl ObscuraLogger for TestLogger {
    fn log(&self, _message: String) {}
    fn decrypt_failed(&self, source_user_id: String, reason: String) {
        self.decrypt_failures
            .lock()
            .unwrap()
            .push((source_user_id, reason));
    }
    fn ack_failed(&self, _envelope_id: String, _reason: String) {}
    fn token_refresh_failed(&self, attempt: i32, reason: String) {
        self.token_refresh_failures
            .lock()
            .unwrap()
            .push((attempt, reason));
    }
    fn pre_key_sync_failed(&self, _reason: String) {}
    fn identity_changed(&self, user_id: String) {
        self.identity_changes.lock().unwrap().push(user_id);
    }
    fn session_establish_failed(&self, _user_id: String, _reason: String) {}
    fn database_error(&self, _store: String, _operation: String, _reason: String) {}
}

#[derive(Default)]
struct TestListener {
    pub auth_states: Mutex<Vec<AuthState>>,
    pub conn_states: Mutex<Vec<ConnectionState>>,
    pub friends_changes: Mutex<u32>,
    pub models_received: Mutex<Vec<EntryModel>>,
    pub typing_events: Mutex<Vec<(String, bool)>>,
}

impl ClientEventListener for TestListener {
    fn on_connection_state_changed(&self, state: ConnectionState) {
        self.conn_states.lock().unwrap().push(state);
    }
    fn on_auth_state_changed(&self, state: AuthState) {
        self.auth_states.lock().unwrap().push(state);
    }
    fn on_friends_changed(&self) {
        *self.friends_changes.lock().unwrap() += 1;
    }
    fn on_message_received(&self, model: EntryModel) {
        self.models_received.lock().unwrap().push(model);
    }
    fn on_peer_typing_changed(&self, peer_user_id: String, is_typing: bool) {
        self.typing_events
            .lock()
            .unwrap()
            .push((peer_user_id, is_typing));
    }
}

struct ServerAccount {
    user_id: String,
    password: String,
    identity_key: String,
}

struct ServerDevice {
    device_id: String,
    user_id: String,
    name: String,
    is_primary: bool,
    registration_id: u32,
    identity_key: String,
    signed_pre_key: SignedPreKeyJson,
    last_resort_kyber_pre_key: KyberPreKeyJson,
    one_time_pre_keys: VecDeque<OneTimePreKeyJson>,
    kyber_pre_keys: VecDeque<KyberPreKeyJson>,
    token: String,
    refresh_token: String,
    expires_at: i64,
    mailbox: Vec<Envelope>,
    ws_sink: Option<Arc<WebSocketSink>>,
}

struct ServerLinkSession {
    user_id: String,
    approved_envelope: Option<Vec<u8>>,
}

#[derive(Default)]
struct FakeServerState {
    accounts: HashMap<String, ServerAccount>, // username_lower -> account
    devices: HashMap<String, ServerDevice>,   // device_id -> device
    tokens: HashMap<String, String>,          // token -> device_id
    refresh_tokens: HashMap<String, String>,  // refresh_token -> device_id
    tickets: HashMap<String, String>,         // ticket -> device_id
    link_sessions: HashMap<String, ServerLinkSession>,
    attachments: HashMap<String, Vec<u8>>,
    idempotency_keys: Vec<String>,
    next_overrides: VecDeque<(String, HttpResponse)>, // (path_prefix, response)
    fail_send_messages: bool,
    reject_refresh: bool,
    malformed_reset_response: bool,
}

#[derive(Clone, Default)]
struct FakeServerTransport {
    state: Arc<Mutex<FakeServerState>>,
}

struct FakeWsHandle {
    server: Arc<Mutex<FakeServerState>>,
    device_id: String,
}

impl WebSocketHandle for FakeWsHandle {
    fn send(&self, bytes: Vec<u8>) -> Result<(), ObscuraError> {
        let frame = WebSocketFrame::decode(&bytes[..])
            .map_err(|e| ObscuraError::protocol(e.to_string()))?;
        if let Some(web_socket_frame::Payload::Ack(ack)) = frame.payload {
            let mut st = self.server.lock().unwrap();
            if let Some(dev) = st.devices.get_mut(&self.device_id) {
                dev.mailbox.retain(|env| !ack.message_ids.contains(&env.id));
            }
        }
        Ok(())
    }

    fn close_socket(&self) {
        let mut st = self.server.lock().unwrap();
        if let Some(dev) = st.devices.get_mut(&self.device_id) {
            dev.ws_sink = None;
        }
    }
}

impl FakeServerTransport {
    pub fn push_override(&self, path_prefix: &str, response: HttpResponse) {
        self.state
            .lock()
            .unwrap()
            .next_overrides
            .push_back((path_prefix.to_owned(), response));
    }

    pub fn set_fail_send_messages(&self, fail: bool) {
        self.state.lock().unwrap().fail_send_messages = fail;
    }

    pub fn set_reject_refresh(&self, reject: bool) {
        self.state.lock().unwrap().reject_refresh = reject;
    }

    pub fn set_malformed_reset(&self, malformed: bool) {
        self.state.lock().unwrap().malformed_reset_response = malformed;
    }

    pub fn invalidate_access_token(&self, device_id: &str) {
        let mut st = self.state.lock().unwrap();
        let old_tok = st.devices.get_mut(device_id).map(|dev| {
            let old = dev.token.clone();
            dev.token = format!("expired_{}", Uuid::new_v4());
            old
        });
        if let Some(tok) = old_tok {
            st.tokens.remove(&tok);
        }
    }

    pub fn drop_websocket(&self, device_id: &str) {
        let sink = {
            let mut st = self.state.lock().unwrap();
            st.devices.get_mut(device_id).and_then(|d| d.ws_sink.take())
        };
        if let Some(s) = sink {
            s.on_closed("Server closed socket".to_owned());
        }
    }

    pub fn send_text_frame(&self, device_id: &str, text: &str) {
        let sink = {
            let st = self.state.lock().unwrap();
            st.devices.get(device_id).and_then(|d| d.ws_sink.clone())
        };
        if let Some(s) = sink {
            s.on_text(text.to_owned());
        }
    }

    pub fn redeliver_unacked(&self, device_id: &str) {
        let (sink, batch) = {
            let st = self.state.lock().unwrap();
            let Some(dev) = st.devices.get(device_id) else {
                return;
            };
            (dev.ws_sink.clone(), dev.mailbox.clone())
        };
        if let Some(s) = sink
            && !batch.is_empty()
        {
            let frame = WebSocketFrame {
                payload: Some(web_socket_frame::Payload::EnvelopeBatch(EnvelopeBatch {
                    envelopes: batch,
                })),
            };
            s.on_binary(frame.encode_to_vec());
        }
    }
}

#[async_trait]
impl Transport for FakeServerTransport {
    async fn execute(&self, request: HttpRequest) -> Result<HttpResponse, ObscuraError> {
        let parsed_url = url::Url::parse(&request.url).unwrap();
        let path = parsed_url.path().to_owned();

        let body_bytes = if let Some(ref fpath) = request.body_file_path {
            std::fs::read(fpath).unwrap_or_default()
        } else {
            request.body.clone().unwrap_or_default()
        };

        let mut deliver_after: Vec<(Arc<WebSocketSink>, Vec<u8>)> = Vec::new();
        let response = {
            let mut st = self.state.lock().unwrap();
            if let Some(idx) = st
                .next_overrides
                .iter()
                .position(|(prefix, _)| path.starts_with(prefix))
            {
                let (_, resp) = st.next_overrides.remove(idx).unwrap();
                return Ok(resp);
            }

            let bearer_dev = request
                .headers
                .get("Authorization")
                .and_then(|h| h.strip_prefix("Bearer "))
                .and_then(|t| st.tokens.get(t).cloned());

            match (request.method.as_str(), path.as_str()) {
                ("POST", "/v1/users") => {
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let username = v["username"].as_str().unwrap().to_owned();
                    let password = v["password"].as_str().unwrap().to_owned();
                    let name = v["name"].as_str().unwrap().to_owned();
                    let keys: DeviceKeysJson = serde_json::from_value(v).unwrap();
                    let uname_lower = username.to_ascii_lowercase();
                    if let std::collections::hash_map::Entry::Vacant(e) =
                        st.accounts.entry(uname_lower)
                    {
                        let user_id = Uuid::new_v4().to_string();
                        e.insert(ServerAccount {
                            user_id: user_id.clone(),
                            password,
                            identity_key: keys.identity_key.clone(),
                        });
                        let dev_resp =
                            provision_server_device(&mut st, &user_id, &name, true, keys);
                        json_resp(201, dev_resp)
                    } else {
                        json_resp(409, json!({"error": "username taken"}))
                    }
                }
                ("POST", "/v1/session") => {
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let username = v["username"].as_str().unwrap();
                    let password = v["password"].as_str().unwrap();
                    let device_id = v["deviceId"].as_str().unwrap();
                    let Some(acc) = st.accounts.get(&username.to_ascii_lowercase()) else {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    };
                    if acc.password != password {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    }
                    let user_id = acc.user_id.clone();
                    let Some(dev) = st.devices.get_mut(device_id) else {
                        return Ok(json_resp(409, json!({"error": "device mismatch"})));
                    };
                    if dev.user_id != user_id {
                        return Ok(json_resp(409, json!({"error": "device mismatch"})));
                    }
                    let token = format!("tok_{}", Uuid::new_v4());
                    let refresh_token = format!("ref_{}", Uuid::new_v4());
                    let expires_at = (obscura_core::runtime::now_ms() / 1000) + 3600;
                    dev.token = token.clone();
                    dev.refresh_token = refresh_token.clone();
                    dev.expires_at = expires_at;
                    st.tokens.insert(token.clone(), device_id.to_owned());
                    st.refresh_tokens
                        .insert(refresh_token.clone(), device_id.to_owned());
                    json_resp(
                        200,
                        json!({
                            "token": token,
                            "refreshToken": refresh_token,
                            "expiresAt": expires_at,
                            "userId": user_id,
                            "deviceId": device_id,
                        }),
                    )
                }
                ("POST", "/v1/session/refresh") => {
                    if st.reject_refresh {
                        return Ok(json_resp(401, json!({"error": "refresh rejected"})));
                    }
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let rtok = v["refreshToken"].as_str().unwrap();
                    let Some(device_id) = st.refresh_tokens.remove(rtok) else {
                        return Ok(json_resp(401, json!({"error": "invalid refresh token"})));
                    };
                    let token = format!("tok_{}", Uuid::new_v4());
                    let refresh_token = format!("ref_{}", Uuid::new_v4());
                    let expires_at = (obscura_core::runtime::now_ms() / 1000) + 3600;
                    let (old_tok, user_id) = {
                        let dev = st.devices.get_mut(&device_id).unwrap();
                        let old = dev.token.clone();
                        dev.token = token.clone();
                        dev.refresh_token = refresh_token.clone();
                        dev.expires_at = expires_at;
                        (old, dev.user_id.clone())
                    };
                    st.tokens.remove(&old_tok);
                    st.tokens.insert(token.clone(), device_id.clone());
                    st.refresh_tokens
                        .insert(refresh_token.clone(), device_id.clone());
                    json_resp(
                        200,
                        json!({
                            "token": token,
                            "refreshToken": refresh_token,
                            "expiresAt": expires_at,
                            "userId": user_id,
                            "deviceId": device_id,
                        }),
                    )
                }
                ("DELETE", "/v1/session") => {
                    if let Some(dev_id) = bearer_dev
                        && let Some(dev) = st.devices.get(&dev_id)
                    {
                        let tok = dev.token.clone();
                        let rtok = dev.refresh_token.clone();
                        st.tokens.remove(&tok);
                        st.refresh_tokens.remove(&rtok);
                    }
                    json_resp(204, json!({}))
                }
                ("POST", "/v1/users/reset") => {
                    if st.malformed_reset_response {
                        return Ok(HttpResponse {
                            status: 200,
                            body: b"{not valid json".to_vec(),
                            retry_after: None,
                        });
                    }
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let username = v["username"].as_str().unwrap().to_owned();
                    let password = v["password"].as_str().unwrap().to_owned();
                    let name = v["name"].as_str().unwrap().to_owned();
                    let keys: DeviceKeysJson = serde_json::from_value(v).unwrap();
                    let Some(acc) = st.accounts.get_mut(&username.to_ascii_lowercase()) else {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    };
                    if acc.password != password {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    }
                    acc.identity_key = keys.identity_key.clone();
                    let user_id = acc.user_id.clone();
                    let old_devs: Vec<String> = st
                        .devices
                        .values()
                        .filter(|d| d.user_id == user_id)
                        .map(|d| d.device_id.clone())
                        .collect();
                    for d_id in old_devs {
                        if let Some(d) = st.devices.remove(&d_id) {
                            st.tokens.remove(&d.token);
                            st.refresh_tokens.remove(&d.refresh_token);
                        }
                    }
                    let dev_resp = provision_server_device(&mut st, &user_id, &name, true, keys);
                    json_resp(200, dev_resp)
                }
                ("POST", "/v1/link-sessions") => {
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let username = v["username"].as_str().unwrap();
                    let password = v["password"].as_str().unwrap();
                    let Some(acc) = st.accounts.get(&username.to_ascii_lowercase()) else {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    };
                    if acc.password != password {
                        return Ok(json_resp(401, json!({"error": "invalid credentials"})));
                    }
                    let id = format!("ls_{}", Uuid::new_v4());
                    let expires_at = (obscura_core::runtime::now_ms() / 1000) + 600;
                    let user_id = acc.user_id.clone();
                    st.link_sessions.insert(
                        id.clone(),
                        ServerLinkSession {
                            user_id: user_id.clone(),
                            approved_envelope: None,
                        },
                    );
                    json_resp(
                        201,
                        json!({
                            "id": id,
                            "userId": user_id,
                            "expiresAt": expires_at,
                        }),
                    )
                }
                ("PUT", p) if p.starts_with("/v1/link-sessions/") => {
                    let Some(_dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let ls_id = p.trim_start_matches("/v1/link-sessions/");
                    let Some(ls) = st.link_sessions.get_mut(ls_id) else {
                        return Ok(json_resp(404, json!({"error": "not found"})));
                    };
                    ls.approved_envelope = Some(body_bytes);
                    json_resp(204, json!({}))
                }
                ("GET", p) if p.starts_with("/v1/link-sessions/") => {
                    let ls_id = p.trim_start_matches("/v1/link-sessions/");
                    let Some(ls) = st.link_sessions.get(ls_id) else {
                        return Ok(json_resp(404, json!({"error": "not found"})));
                    };
                    match &ls.approved_envelope {
                        Some(bytes) => HttpResponse {
                            status: 200,
                            body: bytes.clone(),
                            retry_after: None,
                        },
                        None => HttpResponse {
                            status: 204,
                            body: vec![],
                            retry_after: None,
                        },
                    }
                }
                ("POST", "/v1/devices") => {
                    let v: Value = serde_json::from_slice(&body_bytes).unwrap();
                    let name = v["name"].as_str().unwrap().to_owned();
                    let ls_id = v["linkSessionId"].as_str().unwrap().to_owned();
                    let keys: DeviceKeysJson = serde_json::from_value(v).unwrap();
                    let Some(ls) = st.link_sessions.remove(&ls_id) else {
                        return Ok(json_resp(404, json!({"error": "link session not found"})));
                    };
                    let dev_resp =
                        provision_server_device(&mut st, &ls.user_id, &name, false, keys);
                    json_resp(201, dev_resp)
                }
                ("GET", "/v1/devices") => {
                    let Some(dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let user_id = st.devices.get(&dev_id).unwrap().user_id.clone();
                    let mut devs: Vec<Value> = st
                        .devices
                        .values()
                        .filter(|d| d.user_id == user_id)
                        .map(|d| {
                            json!({
                                "deviceId": d.device_id,
                                "name": d.name,
                                "isPrimary": d.is_primary,
                            })
                        })
                        .collect();
                    devs.sort_by(|a, b| {
                        a["deviceId"]
                            .as_str()
                            .unwrap()
                            .cmp(b["deviceId"].as_str().unwrap())
                    });
                    json_resp(200, json!({ "devices": devs }))
                }
                ("DELETE", p) if p.starts_with("/v1/devices/") => {
                    let Some(_caller_dev) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let target_dev = p.trim_start_matches("/v1/devices/");
                    if let Some(d) = st.devices.remove(target_dev) {
                        st.tokens.remove(&d.token);
                        st.refresh_tokens.remove(&d.refresh_token);
                        json_resp(204, json!({}))
                    } else {
                        json_resp(404, json!({"error": "not found"}))
                    }
                }
                ("GET", "/v1/keys") => {
                    let Some(dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let dev = st.devices.get(&dev_id).unwrap();
                    json_resp(
                        200,
                        serde_json::to_value(PreKeyCounts {
                            one_time: dev.one_time_pre_keys.len() as u32,
                            kyber: dev.kyber_pre_keys.len() as u32,
                        })
                        .unwrap(),
                    )
                }
                ("POST", "/v1/keys") => {
                    let Some(dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let upload: PreKeyUploadJson = serde_json::from_slice(&body_bytes).unwrap();
                    let dev = st.devices.get_mut(&dev_id).unwrap();
                    if let Some(spk) = upload.signed_pre_key {
                        dev.signed_pre_key = spk;
                    }
                    if let Some(lr) = upload.last_resort_kyber_pre_key {
                        dev.last_resort_kyber_pre_key = lr;
                    }
                    if !upload.one_time_pre_keys.is_empty() {
                        dev.one_time_pre_keys = upload.one_time_pre_keys.into();
                    }
                    if !upload.kyber_pre_keys.is_empty() {
                        dev.kyber_pre_keys = upload.kyber_pre_keys.into();
                    }
                    json_resp(204, json!({}))
                }
                ("GET", p) if p.starts_with("/v1/keys/") => {
                    let Some(_caller_dev) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let rest = p.trim_start_matches("/v1/keys/");
                    let parts: Vec<&str> = rest.split('/').collect();
                    let target_uid = parts[0];
                    let single_dev = if parts.len() == 3 && parts[1] == "devices" {
                        Some(parts[2])
                    } else {
                        None
                    };
                    let mut dev_ids: Vec<String> = st
                        .devices
                        .values()
                        .filter(|d| {
                            d.user_id == target_uid && single_dev.is_none_or(|sd| sd == d.device_id)
                        })
                        .map(|d| d.device_id.clone())
                        .collect();
                    dev_ids.sort();
                    if dev_ids.is_empty() {
                        return Ok(json_resp(404, json!({"error": "no devices"})));
                    }
                    let mut bundles = Vec::new();
                    for did in dev_ids {
                        let dev = st.devices.get_mut(&did).unwrap();
                        bundles.push(consume_device_bundle(dev));
                    }
                    if single_dev.is_some() {
                        json_resp(200, bundles.into_iter().next().unwrap())
                    } else {
                        json_resp(200, json!({ "bundles": bundles }))
                    }
                }
                ("POST", "/v1/messages") => {
                    let Some(sender_dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    if st.fail_send_messages {
                        return Ok(json_resp(500, json!({"error": "send disabled"})));
                    }
                    if let Some(idem) = request.headers.get("Idempotency-Key") {
                        st.idempotency_keys.push(idem.clone());
                    }
                    let sender_user_id = st.devices.get(&sender_dev_id).unwrap().user_id.clone();
                    let req = SendMessageRequest::decode(&body_bytes[..]).unwrap();
                    let mut resp = SendMessageResponse::default();

                    for recipient in req.recipients {
                        let rec_uid = uuid_string(&recipient.user_id).unwrap();
                        let current_devs: std::collections::HashSet<String> = st
                            .devices
                            .values()
                            .filter(|d| d.user_id == rec_uid && d.device_id != sender_dev_id)
                            .map(|d| d.device_id.clone())
                            .collect();

                        let mut valid_subs = Vec::new();
                        let mut targeted = std::collections::HashSet::new();
                        for sub in recipient.submissions {
                            let did = uuid_string(&sub.device_id).unwrap();
                            if current_devs.contains(&did) {
                                targeted.insert(did);
                                valid_subs.push(sub);
                            } else {
                                resp.invalid_device_ids.push(sub.device_id);
                            }
                        }

                        if targeted != current_devs {
                            let mut missing: Vec<Vec<u8>> = current_devs
                                .difference(&targeted)
                                .map(|d| uuid_to_bytes(d).unwrap())
                                .collect();
                            missing.sort();
                            resp.device_mismatches
                                .push(send_message_response::DeviceMismatch {
                                    user_id: recipient.user_id,
                                    missing_device_ids: missing,
                                });
                            continue;
                        }

                        for sub in valid_subs {
                            let did = uuid_string(&sub.device_id).unwrap();
                            let env = Envelope {
                                id: uuid_to_bytes(&Uuid::new_v4().to_string()).unwrap(),
                                sender_user_id: uuid_to_bytes(&sender_user_id).unwrap(),
                                sender_device_id: uuid_to_bytes(&sender_dev_id).unwrap(),
                                timestamp: obscura_core::runtime::now_ms() as u64,
                                message: sub.message,
                            };
                            if let Some(target_dev) = st.devices.get_mut(&did) {
                                target_dev.mailbox.push(env.clone());
                                if let Some(ref sink) = target_dev.ws_sink {
                                    let frame = WebSocketFrame {
                                        payload: Some(web_socket_frame::Payload::EnvelopeBatch(
                                            EnvelopeBatch {
                                                envelopes: vec![env],
                                            },
                                        )),
                                    };
                                    deliver_after.push((Arc::clone(sink), frame.encode_to_vec()));
                                }
                            }
                        }
                    }

                    HttpResponse {
                        status: 200,
                        body: resp.encode_to_vec(),
                        retry_after: None,
                    }
                }
                ("POST", "/v1/attachments") => {
                    let Some(_dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let id = Uuid::new_v4().to_string();
                    st.attachments.insert(id.clone(), body_bytes);
                    json_resp(201, json!({ "id": id }))
                }
                ("GET", p) if p.starts_with("/v1/attachments/") => {
                    let Some(_dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let id = p.trim_start_matches("/v1/attachments/");
                    let Some(bytes) = st.attachments.get(id).cloned() else {
                        return Ok(json_resp(404, json!({"error": "not found"})));
                    };
                    if let Some(ref out_path) = request.response_file_path {
                        std::fs::write(out_path, &bytes).unwrap();
                        HttpResponse {
                            status: 200,
                            body: vec![],
                            retry_after: None,
                        }
                    } else {
                        HttpResponse {
                            status: 200,
                            body: bytes,
                            retry_after: None,
                        }
                    }
                }
                ("PUT", "/v1/push-token") => {
                    if bearer_dev.is_none() {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    }
                    json_resp(204, json!({}))
                }
                ("POST", "/v1/gateway/ticket") => {
                    let Some(dev_id) = bearer_dev else {
                        return Ok(json_resp(401, json!({"error": "unauthorized"})));
                    };
                    let ticket = format!("tkt_{}", Uuid::new_v4());
                    st.tickets.insert(ticket.clone(), dev_id);
                    json_resp(200, json!({ "ticket": ticket }))
                }
                _ => json_resp(404, json!({"error": "unknown route"})),
            }
        };

        for (sink, frame_bytes) in deliver_after {
            sink.on_binary(frame_bytes);
        }

        Ok(response)
    }

    fn open_websocket(
        &self,
        url: String,
        sink: Arc<WebSocketSink>,
    ) -> Result<Arc<dyn WebSocketHandle>, ObscuraError> {
        let parsed = url::Url::parse(&url).unwrap();
        let ticket = parsed
            .query_pairs()
            .find(|(k, _)| k == "ticket")
            .map(|(_, v)| v.into_owned())
            .ok_or_else(|| ObscuraError::connection("Missing ticket"))?;

        let (device_id, queued) = {
            let mut st = self.state.lock().unwrap();
            let dev_id = st
                .tickets
                .remove(&ticket)
                .ok_or_else(|| ObscuraError::connection("Invalid ticket"))?;
            let dev = st
                .devices
                .get_mut(&dev_id)
                .ok_or_else(|| ObscuraError::connection("Unknown device"))?;
            dev.ws_sink = Some(Arc::clone(&sink));
            (dev_id, dev.mailbox.clone())
        };

        let sink_clone = Arc::clone(&sink);
        obscura_core::runtime::spawn(async move {
            sink_clone.on_open();
            if !queued.is_empty() {
                let frame = WebSocketFrame {
                    payload: Some(web_socket_frame::Payload::EnvelopeBatch(EnvelopeBatch {
                        envelopes: queued,
                    })),
                };
                sink_clone.on_binary(frame.encode_to_vec());
            }
        });

        Ok(Arc::new(FakeWsHandle {
            server: Arc::clone(&self.state),
            device_id,
        }))
    }
}

fn provision_server_device(
    st: &mut FakeServerState,
    user_id: &str,
    name: &str,
    is_primary: bool,
    keys: DeviceKeysJson,
) -> Value {
    let device_id = Uuid::new_v4().to_string();
    let token = format!("tok_{}", Uuid::new_v4());
    let refresh_token = format!("ref_{}", Uuid::new_v4());
    let expires_at = (obscura_core::runtime::now_ms() / 1000) + 3600;
    st.tokens.insert(token.clone(), device_id.clone());
    st.refresh_tokens
        .insert(refresh_token.clone(), device_id.clone());
    st.devices.insert(
        device_id.clone(),
        ServerDevice {
            device_id: device_id.clone(),
            user_id: user_id.to_owned(),
            name: name.to_owned(),
            is_primary,
            registration_id: keys.registration_id,
            identity_key: keys.identity_key,
            signed_pre_key: keys.signed_pre_key,
            last_resort_kyber_pre_key: keys.last_resort_kyber_pre_key,
            one_time_pre_keys: keys.one_time_pre_keys.into(),
            kyber_pre_keys: keys.kyber_pre_keys.into(),
            token: token.clone(),
            refresh_token: refresh_token.clone(),
            expires_at,
            mailbox: Vec::new(),
            ws_sink: None,
        },
    );
    json!({
        "token": token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at,
        "userId": user_id,
        "deviceId": device_id,
    })
}

fn consume_device_bundle(dev: &mut ServerDevice) -> Value {
    let otp = dev.one_time_pre_keys.pop_front();
    let kyber = dev
        .kyber_pre_keys
        .pop_front()
        .unwrap_or_else(|| dev.last_resort_kyber_pre_key.clone());
    json!({
        "deviceId": dev.device_id,
        "registrationId": dev.registration_id,
        "identityKey": dev.identity_key,
        "signedPreKey": dev.signed_pre_key,
        "kyberPreKey": kyber,
        "oneTimePreKey": otp,
    })
}

fn json_resp(status: u16, body: Value) -> HttpResponse {
    HttpResponse {
        status,
        body: serde_json::to_vec(&body).unwrap(),
        retry_after: None,
    }
}

struct ClientHarness {
    pub client: Arc<ObscuraClient>,
    pub storage: Arc<MemorySessionStorage>,
    pub logger: Arc<TestLogger>,
    pub listener: Arc<TestListener>,
}

fn make_client(
    server: &FakeServerTransport,
    device_name: &str,
    cache_dir: Option<String>,
) -> ClientHarness {
    let storage = Arc::new(MemorySessionStorage::default());
    let logger = Arc::new(TestLogger::default());
    let listener = Arc::new(TestListener::default());
    let client = ObscuraClient::open(
        ObscuraClientConfig {
            api_url: "https://obscura.test".to_owned(),
            database_path: None,
            database_key: vec![],
            device_name: device_name.to_owned(),
            attachment_cache_dir: cache_dir,
        },
        Arc::clone(&storage) as Arc<dyn SessionStorage>,
        Arc::new(server.clone()) as Arc<dyn Transport>,
        Arc::clone(&logger) as Arc<dyn ObscuraLogger>,
        Arc::clone(&listener) as Arc<dyn ClientEventListener>,
    )
    .unwrap();
    ClientHarness {
        client,
        storage,
        logger,
        listener,
    }
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..100 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(cond(), "condition did not become true within timeout");
}

#[tokio::test]
async fn registration_login_linking_history_sync_and_cancel_link() {
    let server = FakeServerTransport::default();
    let temp = tempfile::tempdir().unwrap();

    // 1. Register Alice primary
    let alice_primary = make_client(
        &server,
        "Alice Phone",
        Some(temp.path().join("alice1").to_string_lossy().into_owned()),
    );
    alice_primary
        .client
        .register("alice".to_owned(), "secret123".to_owned())
        .await
        .unwrap();
    assert_eq!(alice_primary.client.auth_state(), AuthState::Authenticated);
    assert!(alice_primary.client.is_primary().await.unwrap());
    alice_primary.client.connect().await.unwrap();
    assert_eq!(
        alice_primary.client.connection_state(),
        ConnectionState::Connected
    );

    // 2. Register Bob primary & friend handshake
    let bob = make_client(
        &server,
        "Bob Phone",
        Some(temp.path().join("bob").to_string_lossy().into_owned()),
    );
    bob.client
        .register("bob".to_owned(), "secret456".to_owned())
        .await
        .unwrap();
    bob.client.connect().await.unwrap();

    let bob_code = bob.client.friend_code().unwrap();
    alice_primary
        .client
        .add_friend_by_code(bob_code)
        .await
        .unwrap();

    let alice_uid = alice_primary.client.user_id().unwrap();
    let bob_uid = bob.client.user_id().unwrap();

    wait_until(|| {
        futures::executor::block_on(bob.client.get_friends())
            .unwrap()
            .iter()
            .any(|f| f.user_id == alice_uid && f.status == FriendStatus::PendingReceived)
    })
    .await;

    bob.client.accept_friend(alice_uid.clone()).await.unwrap();
    wait_until(|| {
        futures::executor::block_on(alice_primary.client.get_friends())
            .unwrap()
            .iter()
            .any(|f| f.user_id == bob_uid && f.status == FriendStatus::Accepted)
    })
    .await;

    // Alice sends a message and updates profile before linking her iPad
    alice_primary
        .client
        .send_message(bob_uid.clone(), "Hello before link!".to_owned())
        .await
        .unwrap();
    alice_primary
        .client
        .update_profile("Alice Wonderland".to_owned(), "Curiouser".to_owned())
        .await
        .unwrap();

    // 3. Login outcomes on unprovisioned client (Alice iPad)
    let alice_ipad = make_client(
        &server,
        "Alice iPad",
        Some(temp.path().join("alice2").to_string_lossy().into_owned()),
    );
    assert_eq!(
        alice_ipad
            .client
            .login("alice".to_owned(), "wrongpass".to_owned())
            .await
            .unwrap(),
        LoginScenario::InvalidCredentials
    );
    assert_eq!(
        alice_ipad
            .client
            .login("alice".to_owned(), "secret123".to_owned())
            .await
            .unwrap(),
        LoginScenario::LinkRequired
    );

    // 4. Test cancel_link on an unapproved link request
    let req_to_cancel = alice_ipad
        .client
        .begin_link(
            "alice".to_owned(),
            "secret123".to_owned(),
            "Alice iPad".to_owned(),
        )
        .await
        .unwrap();
    let ipad_clone = Arc::clone(&alice_ipad.client);
    let link_task =
        obscura_core::runtime::spawn(async move { ipad_clone.complete_link(req_to_cancel).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    alice_ipad.client.cancel_link().await;
    let cancel_res = link_task.await.unwrap();
    assert!(matches!(cancel_res, Err(ObscuraError::LinkFailed { .. })));

    // 5. Link Alice iPad with approval from Alice Phone
    let link_req = alice_ipad
        .client
        .begin_link(
            "alice".to_owned(),
            "secret123".to_owned(),
            "Alice iPad".to_owned(),
        )
        .await
        .unwrap();
    assert_eq!(
        link_code_device_name(link_req.code()).unwrap(),
        "Alice iPad"
    );
    alice_primary
        .client
        .approve_link(link_req.code())
        .await
        .unwrap();
    alice_ipad.client.complete_link(link_req).await.unwrap();

    assert_eq!(alice_ipad.client.auth_state(), AuthState::Authenticated);
    assert!(!alice_ipad.client.is_primary().await.unwrap());
    assert_eq!(alice_ipad.client.get_friends().await.unwrap().len(), 1);
    assert_eq!(alice_ipad.client.get_messages().await.unwrap().len(), 1);
    assert_eq!(
        alice_ipad.client.get_messages().await.unwrap()[0].content,
        "Hello before link!"
    );
    assert_eq!(alice_ipad.client.get_profiles().await.unwrap().len(), 1);

    // 6. Bob sends a message to Alice -> fanout discovers Alice iPad via device_mismatches and delivers to both!
    bob.client
        .send_message(alice_uid.clone(), "Hi both devices!".to_owned())
        .await
        .unwrap();

    wait_until(|| {
        futures::executor::block_on(alice_primary.client.get_messages())
            .unwrap()
            .len()
            == 2
            && futures::executor::block_on(alice_ipad.client.get_messages())
                .unwrap()
                .len()
                == 2
    })
    .await;

    // 7. Device listing and unlink
    let own_devices = alice_primary.client.devices().await.unwrap();
    assert_eq!(own_devices.len(), 2);
    let ipad_dev_id = alice_ipad.client.device_id().unwrap();
    alice_primary
        .client
        .unlink_device(ipad_dev_id.clone())
        .await
        .unwrap();

    // Now if Alice iPad logs out and tries to log back in, server returns 409 -> DeviceMismatch
    alice_ipad.client.logout().await.unwrap();
    assert_eq!(
        alice_ipad
            .client
            .login("alice".to_owned(), "secret123".to_owned())
            .await
            .unwrap(),
        LoginScenario::DeviceMismatch
    );

    alice_primary.client.shutdown().await;
    alice_ipad.client.shutdown().await;
    bob.client.shutdown().await;
}

#[tokio::test]
async fn crossed_friend_requests_and_pending_friend_replies_crash_recovery() {
    let server = FakeServerTransport::default();
    let alice = make_client(&server, "Alice", None);
    let bob = make_client(&server, "Bob", None);

    alice
        .client
        .register("alice".to_owned(), "pass123".to_owned())
        .await
        .unwrap();
    bob.client
        .register("bob".to_owned(), "pass456".to_owned())
        .await
        .unwrap();
    alice.client.connect().await.unwrap();
    bob.client.connect().await.unwrap();

    let _alice_uid = alice.client.user_id().unwrap();
    let bob_uid = bob.client.user_id().unwrap();
    let alice_dev = alice.client.device_id().unwrap();

    // Put Alice in PENDING_SENT toward Bob locally
    alice
        .client
        .add_friend_by_code(bob.client.friend_code().unwrap())
        .await
        .unwrap();
    wait_until(|| {
        !futures::executor::block_on(bob.client.get_friends())
            .unwrap()
            .is_empty()
    })
    .await;

    // Clear Bob's friend store to simulate crossed request where Bob also sends a FRIEND_REQUEST to Alice,
    // while Alice's outbound POST /v1/messages fails on the first delivery!
    server.set_fail_send_messages(true);

    // Craft an incoming FRIEND_REQUEST from Bob to Alice:
    // First let Bob send a normal friend accept when send_messages is enabled, or let's use Bob's accept_friend:
    // Actually, let's reset Bob's local friend row to null and call add_friend_by_code while send_messages is enabled for Bob's send,
    // then fail Alice's automatic ACCEPT reply!
    server.set_fail_send_messages(false);
    // Push a 500 override for the second /v1/messages call (which is Alice's automatic FriendAccept reply to Bob's FriendRequest)
    // Wait: Bob's add_friend_by_code will call /v1/messages once (to Alice) and once (self-sync).
    // Let's invece have Bob's status be deleted locally so Bob sends a fresh FRIEND_REQUEST to Alice:
    bob.client.wipe_device().await.unwrap();
    bob.client
        .reset_account("bob".to_owned(), "pass456".to_owned())
        .await
        .unwrap();
    bob.client.connect().await.unwrap();

    // Fail Alice's reply when she receives Bob's FRIEND_REQUEST:
    // Bob's add_friend_by_code makes 2 POST /v1/messages calls (1 to Alice, 1 self-sync).
    // Wait: in FakeServerTransport, delivery to Alice's WebSocketSink happens right after Bob's first POST /v1/messages!
    // When Alice receives Bob's FRIEND_REQUEST, Alice is in PENDING_SENT toward Bob, so Alice commits the decrypt
    // and records `pending_friend_replies (envelope_id, bob_uid, 'accept')`, then calls `accept_friend(bob_uid)` which calls POST /v1/messages!
    // Let's make Alice's POST /v1/messages fail by pushing a 500 override right after Bob's request!
    // Even simpler: let's disconnect Alice first so the envelope sits in Alice's server mailbox,
    // then set `fail_send_messages = true` on server, then connect Alice!
    alice.client.disconnect();
    bob.client
        .add_friend_by_code(alice.client.friend_code().unwrap())
        .await
        .unwrap();

    // Now Bob's FRIEND_REQUEST is in Alice's mailbox!
    // Turn on `fail_send_messages = true` so Alice's automatic `accept_friend` follow-up fails!
    server.set_fail_send_messages(true);
    alice.client.connect().await.unwrap();
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Alice decrypted Bob's PreKey message (spending the ratchet step!), stored `pending_friend_replies`,
    // and withheld the ack because `accept_friend` failed!
    assert_eq!(
        alice.client.get_friends().await.unwrap()[0].status,
        FriendStatus::PendingSent
    );

    // Now restore network (`fail_send_messages = false`) and redeliver the unacked envelope to Alice!
    // Without `pending_friend_replies`, redelivery would hit `DuplicatedMessage` and never send `FriendAccept` or promote to `Accepted`!
    server.set_fail_send_messages(false);
    server.redeliver_unacked(&alice_dev);

    wait_until(|| {
        futures::executor::block_on(alice.client.get_friends())
            .unwrap()
            .first()
            .is_some_and(|f| f.status == FriendStatus::Accepted)
            && futures::executor::block_on(bob.client.get_friends())
                .unwrap()
                .first()
                .is_some_and(|f| f.status == FriendStatus::Accepted)
    })
    .await;

    assert!(
        alice
            .logger
            .identity_changes
            .lock()
            .unwrap()
            .contains(&bob_uid)
    );

    alice.client.shutdown().await;
    bob.client.shutdown().await;
}

#[tokio::test]
async fn attachments_stories_seen_receipts_outbox_refresh_and_push_drain() {
    let server = FakeServerTransport::default();
    let temp = tempfile::tempdir().unwrap();
    let alice_cache = temp
        .path()
        .join("alice_cache")
        .to_string_lossy()
        .into_owned();
    let bob_cache = temp.path().join("bob_cache").to_string_lossy().into_owned();

    let alice = make_client(&server, "Alice", Some(alice_cache));
    let bob = make_client(&server, "Bob", Some(bob_cache));

    alice
        .client
        .register("alice".to_owned(), "pass123".to_owned())
        .await
        .unwrap();
    bob.client
        .register("bob".to_owned(), "pass456".to_owned())
        .await
        .unwrap();
    alice.client.connect().await.unwrap();
    bob.client.connect().await.unwrap();

    let alice_uid = alice.client.user_id().unwrap();
    let bob_uid = bob.client.user_id().unwrap();

    alice
        .client
        .add_friend_by_code(bob.client.friend_code().unwrap())
        .await
        .unwrap();
    wait_until(|| {
        !futures::executor::block_on(bob.client.get_friends())
            .unwrap()
            .is_empty()
    })
    .await;
    bob.client.accept_friend(alice_uid.clone()).await.unwrap();
    wait_until(|| {
        futures::executor::block_on(alice.client.get_friends())
            .unwrap()
            .first()
            .is_some_and(|f| f.status == FriendStatus::Accepted)
    })
    .await;

    // 1. Capture upload & download_attachment_to_cache
    let capture_src = temp.path().join("photo.jpg");
    std::fs::write(&capture_src, b"\xff\xd8\xff\xe0test_jpeg_payload").unwrap();
    let cap_res = alice
        .client
        .send_capture(
            capture_src.to_string_lossy().into_owned(),
            MediaType::Photo,
            "Look at this".to_owned(),
            Some("{\"y\":0.5}".to_owned()),
            7,
            vec![bob_uid.clone()],
            true,
        )
        .await
        .unwrap();
    assert!(cap_res.undelivered_peer_user_ids.is_empty());
    assert!(!cap_res.story_undelivered);

    wait_until(|| {
        !futures::executor::block_on(bob.client.get_messages())
            .unwrap()
            .is_empty()
            && !futures::executor::block_on(bob.client.get_stories())
                .unwrap()
                .is_empty()
    })
    .await;

    let bob_msgs = bob.client.get_messages().await.unwrap();
    assert_eq!(bob_msgs.len(), 1);
    assert_eq!(bob_msgs[0].kind, ConversationKind::Pix);
    assert_eq!(bob_msgs[0].caption.as_deref(), Some("Look at this"));
    assert_eq!(bob_msgs[0].display_duration, 7);

    let cached_path = bob
        .client
        .download_attachment_to_cache(bob_msgs[0].id.clone())
        .await
        .unwrap();
    assert!(cached_path.ends_with(".jpg"));
    assert_eq!(
        std::fs::read(&cached_path).unwrap(),
        b"\xff\xd8\xff\xe0test_jpeg_payload"
    );

    // 2. mark_seen sends SEEN_RECEIPT back to Alice
    bob.client.mark_seen(bob_msgs[0].id.clone()).await.unwrap();
    wait_until(|| {
        futures::executor::block_on(alice.client.get_messages())
            .unwrap()
            .first()
            .is_some_and(|m| m.viewed_at.is_some())
    })
    .await;

    // 3. Outbox & flush_outbox when send fails then recovers
    server.set_fail_send_messages(true);
    let err = alice
        .client
        .send_message(bob_uid.clone(), "Queued in outbox".to_owned())
        .await
        .unwrap_err();
    assert_eq!(err.code(), "SEND_FAILED");
    assert!(
        alice
            .client
            .get_messages()
            .await
            .unwrap()
            .iter()
            .any(|m| m.content == "Queued in outbox" && m.undelivered)
    );

    server.set_fail_send_messages(false);
    let flushed = alice.client.flush_outbox().await.unwrap();
    assert_eq!(flushed, 1);
    wait_until(|| {
        futures::executor::block_on(bob.client.get_messages())
            .unwrap()
            .iter()
            .any(|m| m.content == "Queued in outbox")
    })
    .await;

    // 4. 401 transparent token refresh + retry, and 429 Retry-After retry
    let alice_dev = alice.client.device_id().unwrap();
    server.invalidate_access_token(&alice_dev);
    server.push_override(
        "/v1/push-token",
        HttpResponse {
            status: 429,
            body: b"rate limited".to_vec(),
            retry_after: Some("0".to_owned()),
        },
    );
    alice
        .client
        .register_push_token("fcm_tok_1".to_owned())
        .await
        .unwrap();

    // Retry-After > 10s throws immediately without waiting
    server.push_override(
        "/v1/push-token",
        HttpResponse {
            status: 429,
            body: b"long wait".to_vec(),
            retry_after: Some("60".to_owned()),
        },
    );
    let rate_err = alice
        .client
        .register_push_token("fcm_tok_2".to_owned())
        .await
        .unwrap_err();
    assert!(matches!(rate_err, ObscuraError::Http { status: 429, .. }));

    // 5. Gateway text frame violation and server drop trigger reconnect, and process_pending_messages drains queued messages
    let bob_dev = bob.client.device_id().unwrap();
    server.send_text_frame(&bob_dev, "unexpected text frame");
    wait_until(|| bob.client.connection_state() == ConnectionState::Reconnecting).await;
    bob.client.connect().await.unwrap();
    server.drop_websocket(&bob_dev);
    wait_until(|| bob.client.connection_state() == ConnectionState::Reconnecting).await;

    bob.client.disconnect();
    alice
        .client
        .send_message(bob_uid.clone(), "While Bob offline".to_owned())
        .await
        .unwrap();
    let drained = bob.client.process_pending_messages(1_500).await.unwrap();
    assert!(drained >= 1);
    assert!(
        bob.client
            .get_messages()
            .await
            .unwrap()
            .iter()
            .any(|m| m.content == "While Bob offline")
    );
    assert!(
        bob.listener
            .models_received
            .lock()
            .unwrap()
            .contains(&EntryModel::DirectMessage)
    );
    assert!(bob.storage.load().unwrap().is_some());

    // Malformed reset_account response preserves local data
    server.set_malformed_reset(true);
    assert!(
        alice
            .client
            .reset_account("alice".to_owned(), "pass123".to_owned())
            .await
            .is_err()
    );
    assert_eq!(alice.client.auth_state(), AuthState::Authenticated);
    assert!(!alice.client.get_messages().await.unwrap().is_empty());
    server.set_malformed_reset(false);

    // Rejected refresh signs out and transitions to LoggedOut
    server.set_reject_refresh(true);
    server.invalidate_access_token(&alice_dev);
    let auth_err = alice
        .client
        .register_push_token("fcm_tok_3".to_owned())
        .await
        .unwrap_err();
    assert_eq!(auth_err, ObscuraError::NotAuthenticated);
    assert_eq!(alice.client.auth_state(), AuthState::LoggedOut);

    alice.client.shutdown().await;
    bob.client.shutdown().await;
}
