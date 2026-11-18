use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libsignal_protocol::IdentityKeyPair;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::crypto::prekeys::{self, ProvisioningKeys};
use crate::error::ObscuraError;
use crate::network::api::{APIClient, AuthResponse, LinkSession};
use crate::network::transport::{ObscuraLogger, SessionStorage};
use crate::store::device_store::{self, LocalDevice};
use crate::store::signal_store::SignalStore;
use crate::store::{DbContext, DbHandle};
use crate::types::{AuthState, LoginScenario};
use crate::wire::uuid_codec::is_uuid;

pub const FRESHNESS_MARGIN_S: i64 = 60;
pub const MIN_REFRESH_DELAY_MS: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenStatus {
    Fresh,
    Rejected,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user_id: String,
    pub device_id: String,
    pub username: String,
}

impl Credentials {
    pub fn to_map(&self) -> HashMap<String, String> {
        HashMap::from([
            ("token".to_owned(), self.token.clone()),
            ("refreshToken".to_owned(), self.refresh_token.clone()),
            ("expiresAt".to_owned(), self.expires_at.to_string()),
            ("userId".to_owned(), self.user_id.clone()),
            ("deviceId".to_owned(), self.device_id.clone()),
            ("username".to_owned(), self.username.clone()),
        ])
    }

    pub fn from_map(map: &HashMap<String, String>) -> Option<Self> {
        let token = map.get("token")?.clone();
        let refresh_token = map.get("refreshToken")?.clone();
        let expires_at: i64 = map.get("expiresAt")?.parse().ok()?;
        let user_id = map.get("userId")?.clone();
        let device_id = map.get("deviceId")?.clone();
        let username = map.get("username")?.clone();
        if token.trim().is_empty()
            || refresh_token.trim().is_empty()
            || expires_at <= 0
            || !is_uuid(&user_id)
            || !is_uuid(&device_id)
            || username.trim().is_empty()
        {
            return None;
        }
        Some(Self {
            token,
            refresh_token,
            expires_at,
            user_id,
            device_id,
            username,
        })
    }
}

#[derive(Clone)]
struct CachedLinkSession {
    username: String,
    password: String,
    session: LinkSession,
}

type RefreshResult = Result<TokenStatus, ObscuraError>;

struct InFlightRefresh {
    rx: watch::Receiver<Option<RefreshResult>>,
    handle: JoinHandle<()>,
}

struct AuthInnerState {
    auth_state: AuthState,
    credentials: Option<Credentials>,
    generation: u64,
    pending_link_session: Option<CachedLinkSession>,
    refresh_failures: u32,
    refresh_in_flight: Option<InFlightRefresh>,
    refresh_loop: Option<JoinHandle<()>>,
}

pub type OnRejectedFn =
    Arc<dyn Fn(Credentials, u64) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
pub type AuthStateChangedFn = Arc<dyn Fn(AuthState) + Send + Sync>;
pub type ClockFn = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct AuthManager {
    db: DbHandle,
    storage: Arc<dyn SessionStorage>,
    device_name: String,
    logger: Arc<dyn ObscuraLogger>,
    on_auth_state_changed: AuthStateChangedFn,
    on_rejected: Mutex<Option<OnRejectedFn>>,
    api: Mutex<Option<APIClient>>,
    clock: ClockFn,
    state: Mutex<AuthInnerState>,
}

impl AuthManager {
    pub fn new(
        db: DbHandle,
        storage: Arc<dyn SessionStorage>,
        device_name: String,
        logger: Arc<dyn ObscuraLogger>,
        on_auth_state_changed: AuthStateChangedFn,
        clock: ClockFn,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            storage,
            device_name,
            logger,
            on_auth_state_changed,
            on_rejected: Mutex::new(None),
            api: Mutex::new(None),
            clock,
            state: Mutex::new(AuthInnerState {
                auth_state: AuthState::LoggedOut,
                credentials: None,
                generation: 0,
                pending_link_session: None,
                refresh_failures: 0,
                refresh_in_flight: None,
                refresh_loop: None,
            }),
        })
    }

    pub fn bind(&self, api: APIClient, on_rejected: OnRejectedFn) {
        *self.api.lock().unwrap_or_else(|p| p.into_inner()) = Some(api);
        *self.on_rejected.lock().unwrap_or_else(|p| p.into_inner()) = Some(on_rejected);
    }

    fn api(&self) -> APIClient {
        self.api
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .expect("APIClient not bound to AuthManager")
    }

    pub fn auth_state(&self) -> AuthState {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .auth_state
    }

    pub fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
    }

    pub fn credentials(&self) -> Option<Credentials> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .credentials
            .clone()
    }

    pub fn require_credentials(&self) -> Result<Credentials, ObscuraError> {
        self.credentials().ok_or(ObscuraError::NotAuthenticated)
    }

    pub async fn register(
        self: &Arc<Self>,
        username: &str,
        password: &str,
    ) -> Result<(), ObscuraError> {
        validate_login(username, password)?;
        self.require_unprovisioned().await?;
        let keys = self.new_identity_keys().await?;
        let device_keys = keys.to_device_keys()?;
        let response = self
            .api()
            .register_user(username, password, &self.device_name, &device_keys)
            .await?;
        self.install(
            response.clone(),
            username,
            keys,
            &response.device_id,
            None,
            true,
            |_| Ok(()),
        )
        .await
    }

    pub async fn reset_account<F, Fut>(
        self: &Arc<Self>,
        username: &str,
        password: &str,
        before_install: F,
    ) -> Result<(), ObscuraError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), ObscuraError>>,
    {
        validate_login(username, password)?;
        let keys = self.new_identity_keys().await?;
        let device_keys = keys.to_device_keys()?;
        let response = self
            .api()
            .reset_account(username, password, &self.device_name, &device_keys)
            .await?;
        before_install().await?;
        self.install(
            response.clone(),
            username,
            keys,
            &response.device_id,
            None,
            true,
            |_| Ok(()),
        )
        .await
    }

    pub async fn take_or_create_link_session(
        &self,
        username: &str,
        password: &str,
    ) -> Result<LinkSession, ObscuraError> {
        validate_login(username, password)?;
        self.require_unprovisioned().await?;
        let now_s = (self.clock)() / 1000;
        {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(cached) = st.pending_link_session.take()
                && cached.username == username
                && cached.password == password
                && cached.session.expires_at > now_s + 30
            {
                return Ok(cached.session);
            }
        }
        self.api().create_link_session(username, password).await
    }

    pub async fn login(
        self: &Arc<Self>,
        username: &str,
        password: &str,
    ) -> Result<LoginScenario, ObscuraError> {
        validate_login(username, password)?;
        let (local_device_id, has_identity) = self
            .db
            .read(|conn| {
                Ok((
                    device_store::get_local(conn)?.map(|d| d.device_id),
                    SignalStore::has_identity(conn)?,
                ))
            })
            .await?;

        let Some(local_device_id) = local_device_id else {
            let session = match self.api().create_link_session(username, password).await {
                Ok(s) => s,
                Err(ObscuraError::Http {
                    status: 401 | 403, ..
                }) => return Ok(LoginScenario::InvalidCredentials),
                Err(e) => return Err(e),
            };
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            st.pending_link_session = Some(CachedLinkSession {
                username: username.to_owned(),
                password: password.to_owned(),
                session,
            });
            return Ok(LoginScenario::LinkRequired);
        };

        let response = match self.api().login(username, password, &local_device_id).await {
            Ok(r) => r,
            Err(ObscuraError::Http {
                status: 401 | 403, ..
            }) => return Ok(LoginScenario::InvalidCredentials),
            Err(ObscuraError::Http { status: 409, .. }) => {
                return Ok(LoginScenario::DeviceMismatch);
            }
            Err(e) => return Err(e),
        };

        if response.device_id != local_device_id || !has_identity {
            return Ok(LoginScenario::DeviceMismatch);
        }

        self.start(
            Credentials {
                token: response.token,
                refresh_token: response.refresh_token,
                expires_at: response.expires_at,
                user_id: response.user_id,
                device_id: local_device_id,
                username: username.to_owned(),
            },
            true,
        )?;
        Ok(LoginScenario::ExistingDevice)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn provision_linked<F>(
        self: &Arc<Self>,
        expected_user_id: &str,
        primary_device_id: &str,
        username: &str,
        name: &str,
        keys: ProvisioningKeys,
        link_session_id: &str,
        persist: F,
    ) -> Result<(), ObscuraError>
    where
        F: FnOnce(&mut DbContext<'_>) -> Result<(), ObscuraError> + Send + 'static,
    {
        self.require_unprovisioned().await?;
        let device_keys = keys.to_device_keys()?;
        let response = self
            .api()
            .provision_device(name, &device_keys, link_session_id)
            .await?;
        self.install(
            response,
            username,
            keys,
            primary_device_id,
            Some(expected_user_id),
            false,
            persist,
        )
        .await
    }

    pub fn publish_authenticated(&self) {
        let notify = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.credentials.is_some() && st.auth_state != AuthState::Authenticated {
                st.auth_state = AuthState::Authenticated;
                true
            } else {
                false
            }
        };
        if notify {
            (self.on_auth_state_changed)(AuthState::Authenticated);
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn install<F>(
        self: &Arc<Self>,
        response: AuthResponse,
        username: &str,
        keys: ProvisioningKeys,
        primary_device_id: &str,
        expected_user_id: Option<&str>,
        publish_auth: bool,
        persist: F,
    ) -> Result<(), ObscuraError>
    where
        F: FnOnce(&mut DbContext<'_>) -> Result<(), ObscuraError> + Send + 'static,
    {
        if let Some(expected) = expected_user_id
            && response.user_id != expected
        {
            return Err(ObscuraError::protocol(
                "Provisioning returned another account",
            ));
        }
        let user_id = response.user_id.clone();
        let device_id = response.device_id.clone();
        let primary_id = primary_device_id.to_owned();
        self.db
            .write_tx(move |ctx| {
                prekeys::install(ctx.conn, &keys)?;
                device_store::store_local(
                    ctx.conn,
                    &user_id,
                    &LocalDevice {
                        device_id,
                        primary_device_id: primary_id,
                    },
                )?;
                persist(ctx)
            })
            .await?;

        self.start(
            Credentials {
                token: response.token,
                refresh_token: response.refresh_token,
                expires_at: response.expires_at,
                user_id: response.user_id,
                device_id: response.device_id,
                username: username.to_owned(),
            },
            publish_auth,
        )
    }

    async fn new_identity_keys(&self) -> Result<ProvisioningKeys, ObscuraError> {
        let now = (self.clock)();
        crate::runtime::spawn_blocking(move || {
            let identity = IdentityKeyPair::generate(&mut rand::rng());
            prekeys::generate_provisioning_keys_sync(identity, now)
        })
        .await
        .map_err(|e| ObscuraError::storage(format!("Identity key generation failed: {e}")))?
    }

    pub async fn restore(self: &Arc<Self>) -> Result<bool, ObscuraError> {
        let loaded = {
            let _st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.stored("load", || self.storage.load())?
        };
        let stored = loaded.as_ref().and_then(Credentials::from_map);
        let (local_device_id, has_identity) = self
            .db
            .read(|conn| {
                Ok((
                    device_store::get_local(conn)?.map(|d| d.device_id),
                    SignalStore::has_identity(conn)?,
                ))
            })
            .await?;

        let Some(stored) = stored else {
            let _st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.stored("clear", || self.storage.clear())?;
            return Ok(false);
        };
        if !has_identity || local_device_id.as_deref() != Some(stored.device_id.as_str()) {
            let _st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.stored("clear", || self.storage.clear())?;
            return Ok(false);
        }

        self.start(stored, true)?;
        Ok(self.ensure_fresh_token().await? != TokenStatus::Rejected)
    }

    pub async fn revoke(&self, current: &Credentials) {
        if let Err(e) = self.api().logout(&current.token).await {
            self.logger
                .log(format!("logout: refresh token not revoked: {e}"));
        }
    }

    pub fn end(
        &self,
        expected: Option<&Credentials>,
        expected_generation: Option<u64>,
    ) -> Result<Option<Credentials>, ObscuraError> {
        let (previous, notify) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(exp) = expected
                && st.credentials.as_ref() != Some(exp)
            {
                return Ok(None);
            }
            if let Some(exp_gen) = expected_generation
                && st.generation != exp_gen
            {
                return Ok(None);
            }
            let previous = st.credentials.take();
            st.generation += 1;
            st.pending_link_session = None;
            if let Some(job) = st.refresh_loop.take() {
                job.abort();
            }
            if let Some(inflight) = st.refresh_in_flight.take()
                && expected.is_none()
            {
                inflight.handle.abort();
            }
            let notify = st.auth_state != AuthState::LoggedOut;
            st.auth_state = AuthState::LoggedOut;
            let clear_res = self.stored("clear", || self.storage.clear());
            if let Err(e) = clear_res {
                if notify {
                    drop(st);
                    (self.on_auth_state_changed)(AuthState::LoggedOut);
                }
                return Err(e);
            }
            (previous, notify)
        };
        if notify {
            (self.on_auth_state_changed)(AuthState::LoggedOut);
        }
        Ok(previous)
    }

    pub async fn ensure_fresh_token(self: &Arc<Self>) -> Result<TokenStatus, ObscuraError> {
        self.refresh_if_needed(false).await
    }

    pub async fn refresh(self: &Arc<Self>) -> Result<TokenStatus, ObscuraError> {
        self.refresh_if_needed(true).await
    }

    async fn refresh_if_needed(self: &Arc<Self>, force: bool) -> Result<TokenStatus, ObscuraError> {
        let mut rx = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let Some(current) = st.credentials.clone() else {
                return Ok(TokenStatus::Rejected);
            };
            if let Some(ref inflight) = st.refresh_in_flight
                && !inflight.handle.is_finished()
                && inflight.rx.borrow().is_none()
            {
                inflight.rx.clone()
            } else {
                if !force && self.seconds_until_expiry(current.expires_at) > FRESHNESS_MARGIN_S {
                    return Ok(TokenStatus::Fresh);
                }
                let version = st.generation;
                let (tx, rx) = watch::channel(None);
                let auth = Arc::clone(self);
                let handle = crate::runtime::spawn(async move {
                    let res = auth.perform_refresh(current, version).await;
                    let _ = tx.send(Some(res));
                });
                st.refresh_in_flight = Some(InFlightRefresh {
                    rx: rx.clone(),
                    handle,
                });
                rx
            }
        };

        loop {
            if let Some(res) = rx.borrow().clone() {
                return res;
            }
            if rx.changed().await.is_err() {
                return Ok(if self.credentials().is_none() {
                    TokenStatus::Rejected
                } else {
                    TokenStatus::Unavailable
                });
            }
        }
    }

    async fn perform_refresh(
        self: &Arc<Self>,
        current: Credentials,
        version: u64,
    ) -> Result<TokenStatus, ObscuraError> {
        let response = match self.api().refresh_session(&current.refresh_token).await {
            Ok(r) => r,
            Err(e) => {
                let failure_count = {
                    let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                    if st.generation != version || st.credentials.as_ref() != Some(&current) {
                        return Ok(if st.credentials.is_none() {
                            TokenStatus::Rejected
                        } else {
                            TokenStatus::Fresh
                        });
                    }
                    st.refresh_failures += 1;
                    st.refresh_failures as i32
                };
                if !matches!(
                    e,
                    ObscuraError::ConnectionFailed { .. } | ObscuraError::Http { .. }
                ) {
                    return Err(e);
                }
                self.logger
                    .token_refresh_failed(failure_count, e.to_string());
                if matches!(
                    e,
                    ObscuraError::Http {
                        status: 401 | 403,
                        ..
                    }
                ) {
                    let cb = self
                        .on_rejected
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .clone();
                    if let Some(on_rejected) = cb {
                        on_rejected(current, version).await;
                    }
                    return Ok(if self.credentials().is_none() {
                        TokenStatus::Rejected
                    } else {
                        TokenStatus::Fresh
                    });
                }
                return Ok(TokenStatus::Unavailable);
            }
        };

        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if st.generation != version || st.credentials.as_ref() != Some(&current) {
            return Ok(if st.credentials.is_none() {
                TokenStatus::Rejected
            } else {
                TokenStatus::Fresh
            });
        }
        if response.user_id != current.user_id || response.device_id != current.device_id {
            return Err(ObscuraError::protocol(
                "Refresh returned credentials for another session",
            ));
        }
        let refreshed = Credentials {
            token: response.token,
            refresh_token: response.refresh_token,
            expires_at: response.expires_at,
            user_id: current.user_id,
            device_id: current.device_id,
            username: current.username,
        };
        self.stored("save", || self.storage.save(refreshed.to_map()))?;
        st.credentials = Some(refreshed);
        st.refresh_failures = 0;
        Ok(TokenStatus::Fresh)
    }

    fn start(
        self: &Arc<Self>,
        new_creds: Credentials,
        publish_auth: bool,
    ) -> Result<(), ObscuraError> {
        let notify = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            self.stored("save", || self.storage.save(new_creds.to_map()))?;
            st.generation += 1;
            st.pending_link_session = None;
            if let Some(inflight) = st.refresh_in_flight.take() {
                inflight.handle.abort();
            }
            st.credentials = Some(new_creds);
            st.refresh_failures = 0;
            if let Some(job) = st.refresh_loop.take() {
                job.abort();
            }
            let auth = Arc::clone(self);
            st.refresh_loop = Some(crate::runtime::spawn(async move {
                auth.refresh_ahead_of_expiry().await;
            }));
            if publish_auth && st.auth_state != AuthState::Authenticated {
                st.auth_state = AuthState::Authenticated;
                true
            } else {
                false
            }
        };
        if notify {
            (self.on_auth_state_changed)(AuthState::Authenticated);
        }
        Ok(())
    }

    async fn refresh_ahead_of_expiry(self: Arc<Self>) {
        loop {
            let delay_ms = {
                let st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.refresh_failures == 0 {
                    let Some(ref creds) = st.credentials else {
                        return;
                    };
                    let remaining_s = self.seconds_until_expiry(creds.expires_at);
                    ((remaining_s.saturating_mul(800)).max(MIN_REFRESH_DELAY_MS as i64)) as u64
                } else {
                    retry_delay_ms(st.refresh_failures)
                }
            };
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            match self.refresh().await {
                Ok(TokenStatus::Rejected) => return,
                Ok(_) => {}
                Err(e) => {
                    self.logger
                        .log(format!("SESSION automatic refresh stopped: {e}"));
                    return;
                }
            }
        }
    }

    fn seconds_until_expiry(&self, expires_at: i64) -> i64 {
        expires_at - (self.clock)() / 1000
    }

    pub async fn require_unprovisioned(&self) -> Result<(), ObscuraError> {
        let (has_device, has_identity) = self
            .db
            .read(|conn| {
                Ok((
                    device_store::get_local(conn)?.is_some(),
                    SignalStore::has_identity(conn)?,
                ))
            })
            .await?;
        if has_device || has_identity {
            return Err(ObscuraError::invalid_arg(
                "Wipe the local device before provisioning another",
            ));
        }
        Ok(())
    }

    pub fn stop_background_tasks(&self) {
        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(job) = st.refresh_loop.take() {
            job.abort();
        }
        if let Some(inflight) = st.refresh_in_flight.take() {
            inflight.handle.abort();
        }
    }

    fn stored<T>(
        &self,
        operation: &str,
        f: impl FnOnce() -> Result<T, ObscuraError>,
    ) -> Result<T, ObscuraError> {
        f().map_err(|e| ObscuraError::storage(format!("Session storage {operation} failed: {e}")))
    }
}

fn validate_login(username: &str, password: &str) -> Result<(), ObscuraError> {
    if username.trim().is_empty() || password.trim().is_empty() {
        return Err(ObscuraError::invalid_arg(
            "Username and password must not be blank",
        ));
    }
    Ok(())
}

pub fn retry_delay_ms(failures: u32) -> u64 {
    let shift = failures.saturating_sub(1).min(6);
    (5_000u64 << shift).min(300_000)
}
