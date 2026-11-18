use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prost::Message as _;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::error::ObscuraError;
use crate::network::api::APIClient;
use crate::network::transport::{Transport, WebSocketHandle, WebSocketSink};
use crate::proto::server::{AckMessage, Envelope, WebSocketFrame, web_socket_frame};
use crate::types::ConnectionState;

pub type BeforeConnectFn =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), ObscuraError>> + Send>> + Send + Sync>;
pub type StateChangedFn = Arc<dyn Fn(ConnectionState) + Send + Sync>;
pub type LogFn = Arc<dyn Fn(String) + Send + Sync>;

struct PendingAttempt {
    id: u64,
    tx: watch::Sender<Option<Result<(), ObscuraError>>>,
    rx: watch::Receiver<Option<Result<(), ObscuraError>>>,
}

impl PendingAttempt {
    fn new(id: u64) -> Self {
        let (tx, rx) = watch::channel(None);
        Self { id, tx, rx }
    }

    fn complete(&self, res: Result<(), ObscuraError>) {
        let _ = self.tx.send(Some(res));
    }
}

struct State {
    connection_state: ConnectionState,
    socket: Option<Arc<dyn WebSocketHandle>>,
    generation: u64,
    next_attempt_id: u64,
    pending: Option<Arc<PendingAttempt>>,
    reconnect_job: Option<JoinHandle<()>>,
    reconnect_attempts: u32,
    envelopes: VecDeque<Envelope>,
}

pub(crate) struct GatewayInner {
    api: APIClient,
    transport: Arc<dyn Transport>,
    before_connect: BeforeConnectFn,
    on_state_changed: StateChangedFn,
    log: LogFn,
    envelope_notify: Arc<Notify>,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Gateway {
    inner: Arc<GatewayInner>,
}

impl Gateway {
    pub fn new(
        api: APIClient,
        transport: Arc<dyn Transport>,
        before_connect: BeforeConnectFn,
        on_state_changed: StateChangedFn,
        log: LogFn,
    ) -> Self {
        Self {
            inner: Arc::new(GatewayInner {
                api,
                transport,
                before_connect,
                on_state_changed,
                log,
                envelope_notify: Arc::new(Notify::new()),
                state: Mutex::new(State {
                    connection_state: ConnectionState::Disconnected,
                    socket: None,
                    generation: 0,
                    next_attempt_id: 0,
                    pending: None,
                    reconnect_job: None,
                    reconnect_attempts: 0,
                    envelopes: VecDeque::new(),
                }),
            }),
        }
    }

    pub async fn next_envelope(&self) -> Envelope {
        loop {
            let notified = self.inner.envelope_notify.notified();
            {
                let mut st = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(env) = st.envelopes.pop_front() {
                    return env;
                }
            }
            notified.await;
        }
    }

    pub fn state(&self) -> ConnectionState {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .connection_state
    }

    pub async fn connect(&self) -> Result<(), ObscuraError> {
        self.inner.connect().await
    }

    pub fn disconnect(&self) {
        self.inner.disconnect();
    }

    pub fn ack(&self, envelope_id: Vec<u8>) -> Result<(), ObscuraError> {
        let socket = {
            let st = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
            st.socket.clone()
        }
        .ok_or_else(|| ObscuraError::connection("Not connected"))?;

        let frame = WebSocketFrame {
            payload: Some(web_socket_frame::Payload::Ack(AckMessage {
                message_ids: vec![envelope_id],
            })),
        };
        socket.send(frame.encode_to_vec())
    }
}

impl GatewayInner {
    async fn connect(self: &Arc<Self>) -> Result<(), ObscuraError> {
        let (attempt, owner, state_change) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.connection_state == ConnectionState::Connected {
                return Ok(());
            }
            if let Some(ref existing) = st.pending {
                (Arc::clone(existing), false, None)
            } else {
                st.next_attempt_id += 1;
                let attempt = Arc::new(PendingAttempt::new(st.next_attempt_id));
                st.pending = Some(Arc::clone(&attempt));
                if let Some(job) = st.reconnect_job.take() {
                    job.abort();
                }
                let change = set_state(&mut st, ConnectionState::Connecting);
                (attempt, true, change)
            }
        };
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }

        if owner && let Err(e) = self.open_attempt(&attempt).await {
            let state_change = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if abandon_locked(&mut st, &attempt) {
                    set_state(&mut st, ConnectionState::Disconnected)
                } else {
                    None
                }
            };
            if let Some(new_state) = state_change {
                (self.on_state_changed)(new_state);
            }
            return Err(connection_error(e));
        }

        await_attempt(&attempt).await
    }

    fn disconnect(self: &Arc<Self>) {
        let (closing, attempt, state_change) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            st.generation += 1;
            if let Some(job) = st.reconnect_job.take() {
                job.abort();
            }
            st.reconnect_attempts = 0;
            st.envelopes.clear();
            let change = set_state(&mut st, ConnectionState::Disconnected);
            let socket = st.socket.take();
            let pending = st.pending.take();
            (socket, pending, change)
        };
        if let Some(att) = attempt {
            att.complete(Err(ObscuraError::connection("Disconnected")));
        }
        if let Some(sock) = closing {
            sock.close_socket();
        }
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }
    }

    async fn open_attempt(
        self: &Arc<Self>,
        attempt: &Arc<PendingAttempt>,
    ) -> Result<(), ObscuraError> {
        let res: Result<(), ObscuraError> = async {
            (self.before_connect)().await?;
            let ticket = self.api.fetch_gateway_ticket().await?;
            let url = self.api.gateway_url(&ticket);

            let generation = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.pending.as_ref().map(|p| p.id) != Some(attempt.id) {
                    return Err(ObscuraError::connection("Disconnected"));
                }
                st.generation += 1;
                st.generation
            };

            let sink = Arc::new(WebSocketSink::new(Arc::downgrade(self), generation));
            let handle = self.transport.open_websocket(url, sink)?;

            let stale_handle = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.generation != generation
                    || st.pending.as_ref().map(|p| p.id) != Some(attempt.id)
                {
                    if st.connection_state == ConnectionState::Connected {
                        None
                    } else {
                        Some(handle)
                    }
                } else {
                    st.socket = Some(handle);
                    None
                }
            };
            if let Some(h) = stale_handle {
                h.close_socket();
                return Err(ObscuraError::connection("Disconnected"));
            }

            await_attempt(attempt).await
        }
        .await;

        if let Err(ref e) = res {
            attempt.complete(Err(connection_error(e.clone())));
        }
        res
    }

    pub(crate) fn on_open(self: &Arc<Self>, generation: u64) {
        let (attempt, state_change) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.generation != generation {
                return;
            }
            st.reconnect_attempts = 0;
            let att = st.pending.take();
            let change = set_state(&mut st, ConnectionState::Connected);
            (att, change)
        };
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }
        if let Some(att) = attempt {
            att.complete(Ok(()));
        }
    }

    pub(crate) fn on_binary(self: &Arc<Self>, generation: u64, bytes: Vec<u8>) {
        if !self.is_current(generation) {
            return;
        }
        let frame = match WebSocketFrame::decode(&bytes[..]) {
            Ok(f) => f,
            Err(e) => {
                (self.log)(format!(
                    "GATEWAY undecodable frame ({} bytes): {e}",
                    bytes.len()
                ));
                self.fail_socket(
                    generation,
                    ObscuraError::protocol("Undecodable gateway frame"),
                );
                return;
            }
        };
        let Some(web_socket_frame::Payload::EnvelopeBatch(batch)) = frame.payload else {
            (self.log)(format!("GATEWAY invalid server frame: {:?}", frame.payload));
            self.fail_socket(
                generation,
                ObscuraError::protocol("Unexpected gateway frame"),
            );
            return;
        };

        let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if st.generation != generation {
            return;
        }
        let has_envelopes = !batch.envelopes.is_empty();
        for env in batch.envelopes {
            st.envelopes.push_back(env);
        }
        drop(st);
        if has_envelopes {
            self.envelope_notify.notify_waiters();
        }
    }

    pub(crate) fn on_text(self: &Arc<Self>, generation: u64, text: String) {
        if !self.is_current(generation) {
            return;
        }
        (self.log)(format!(
            "GATEWAY invalid text frame ({} characters)",
            text.len()
        ));
        self.fail_socket(
            generation,
            ObscuraError::protocol("Gateway sent a text frame"),
        );
    }

    pub(crate) fn on_closed(self: &Arc<Self>, generation: u64, reason: String) {
        let msg = if reason.trim().is_empty() {
            "Gateway closed".to_owned()
        } else {
            reason
        };
        self.ended(generation, ObscuraError::connection(msg), false);
    }

    fn fail_socket(self: &Arc<Self>, generation: u64, err: ObscuraError) {
        self.ended(generation, err, true);
    }

    fn ended(self: &Arc<Self>, generation: u64, cause: ObscuraError, close_socket: bool) {
        let (was_open, old_socket, attempt) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.generation != generation {
                return;
            }
            st.generation += 1;
            let sock = st.socket.take();
            let was_open = st.connection_state == ConnectionState::Connected;
            let att = st.pending.clone();
            (was_open, sock, att)
        };
        if close_socket && let Some(sock) = old_socket {
            sock.close_socket();
        }
        if was_open {
            (self.log)(format!("GATEWAY dropped: {cause}"));
            self.schedule_reconnect();
        } else if let Some(att) = attempt {
            att.complete(Err(cause));
        }
    }

    fn schedule_reconnect(self: &Arc<Self>) {
        let state_change = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let delay_ms = (1_000u64 << st.reconnect_attempts.min(5)).min(30_000);
            st.reconnect_attempts = st.reconnect_attempts.saturating_add(1);
            let gw = Arc::clone(self);
            let job = crate::runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                let attempt = {
                    let mut st = gw.state.lock().unwrap_or_else(|p| p.into_inner());
                    if st.pending.is_some() || st.connection_state == ConnectionState::Disconnected
                    {
                        return;
                    }
                    st.next_attempt_id += 1;
                    let att = Arc::new(PendingAttempt::new(st.next_attempt_id));
                    st.pending = Some(Arc::clone(&att));
                    att
                };
                if let Err(e) = gw.open_attempt(&attempt).await {
                    (gw.log)(format!("GATEWAY reconnect failed: {e}"));
                    let should_reschedule = {
                        let mut st = gw.state.lock().unwrap_or_else(|p| p.into_inner());
                        abandon_locked(&mut st, &attempt)
                    };
                    if should_reschedule {
                        gw.schedule_reconnect();
                    }
                }
            });
            st.reconnect_job = Some(job);
            set_state(&mut st, ConnectionState::Reconnecting)
        };
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }
    }

    fn is_current(&self, generation: u64) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generation
            == generation
    }
}

fn abandon_locked(st: &mut State, attempt: &Arc<PendingAttempt>) -> bool {
    if st.pending.as_ref().map(|p| p.id) != Some(attempt.id) {
        return false;
    }
    st.pending = None;
    st.generation += 1;
    if let Some(sock) = st.socket.take() {
        sock.close_socket();
    }
    true
}

fn set_state(st: &mut State, next: ConnectionState) -> Option<ConnectionState> {
    if st.connection_state != next {
        st.connection_state = next;
        Some(next)
    } else {
        None
    }
}

async fn await_attempt(attempt: &PendingAttempt) -> Result<(), ObscuraError> {
    let mut rx = attempt.rx.clone();
    loop {
        if let Some(res) = rx.borrow().clone() {
            return res;
        }
        if rx.changed().await.is_err() {
            return Err(ObscuraError::connection("Disconnected"));
        }
    }
}

fn connection_error(err: ObscuraError) -> ObscuraError {
    match err {
        ObscuraError::ConnectionFailed { .. } | ObscuraError::ProtocolViolation { .. } => err,
        other => ObscuraError::connection(other.to_string()),
    }
}
