use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
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
    opened_early: AtomicBool,
}

impl PendingAttempt {
    fn new(id: u64) -> Self {
        let (tx, _) = watch::channel(None);
        Self {
            id,
            tx,
            opened_early: AtomicBool::new(false),
        }
    }

    /// Stores the outcome even when no one is awaiting yet: `await_attempt`
    /// subscribes lazily, and `watch::Sender::send` drops the value when there
    /// are no receivers.
    fn complete(&self, res: Result<(), ObscuraError>) {
        self.tx.send_replace(Some(res));
    }
}

enum ReconnectStep {
    Backoff(JoinHandle<()>),
    Opening {
        attempt: Arc<PendingAttempt>,
        socket: Option<Arc<dyn WebSocketHandle>>,
    },
}

enum GatewayPhase {
    Disconnected,
    Connecting {
        attempt: Arc<PendingAttempt>,
        socket: Option<Arc<dyn WebSocketHandle>>,
    },
    Connected {
        socket: Arc<dyn WebSocketHandle>,
    },
    Reconnecting(ReconnectStep),
}

impl GatewayPhase {
    fn connection_state(&self) -> ConnectionState {
        match self {
            GatewayPhase::Disconnected => ConnectionState::Disconnected,
            GatewayPhase::Connecting { .. } => ConnectionState::Connecting,
            GatewayPhase::Connected { .. } => ConnectionState::Connected,
            GatewayPhase::Reconnecting(_) => ConnectionState::Reconnecting,
        }
    }

    fn pending_attempt(&self) -> Option<&Arc<PendingAttempt>> {
        match self {
            GatewayPhase::Connecting { attempt, .. }
            | GatewayPhase::Reconnecting(ReconnectStep::Opening { attempt, .. }) => Some(attempt),
            GatewayPhase::Disconnected
            | GatewayPhase::Connected { .. }
            | GatewayPhase::Reconnecting(ReconnectStep::Backoff(_)) => None,
        }
    }

    fn socket(&self) -> Option<Arc<dyn WebSocketHandle>> {
        match self {
            GatewayPhase::Connected { socket } => Some(Arc::clone(socket)),
            GatewayPhase::Connecting { socket, .. }
            | GatewayPhase::Reconnecting(ReconnectStep::Opening { socket, .. }) => socket.clone(),
            GatewayPhase::Disconnected | GatewayPhase::Reconnecting(ReconnectStep::Backoff(_)) => {
                None
            }
        }
    }

    fn take_opening_socket(&mut self) -> Option<Arc<dyn WebSocketHandle>> {
        match self {
            GatewayPhase::Connecting { socket, .. }
            | GatewayPhase::Reconnecting(ReconnectStep::Opening { socket, .. }) => socket.take(),
            GatewayPhase::Disconnected
            | GatewayPhase::Connected { .. }
            | GatewayPhase::Reconnecting(ReconnectStep::Backoff(_)) => None,
        }
    }
}

struct State {
    phase: GatewayPhase,
    generation: u64,
    next_attempt_id: u64,
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
                    phase: GatewayPhase::Disconnected,
                    generation: 0,
                    next_attempt_id: 0,
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
            .phase
            .connection_state()
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
            st.phase.socket()
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
            if matches!(st.phase, GatewayPhase::Connected { .. }) {
                return Ok(());
            }
            if let Some(existing) = st.phase.pending_attempt() {
                (Arc::clone(existing), false, None)
            } else {
                st.next_attempt_id += 1;
                let attempt = Arc::new(PendingAttempt::new(st.next_attempt_id));
                if let GatewayPhase::Reconnecting(ReconnectStep::Backoff(ref job)) = st.phase {
                    job.abort();
                }
                let change = transition(
                    &mut st,
                    GatewayPhase::Connecting {
                        attempt: Arc::clone(&attempt),
                        socket: None,
                    },
                );
                (attempt, true, change)
            }
        };
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }

        if owner && let Err(e) = self.open_attempt(&attempt).await {
            let (closing, state_change) = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.phase.pending_attempt().map(|p| p.id) == Some(attempt.id) {
                    st.generation += 1;
                    let sock = st.phase.take_opening_socket();
                    let change = transition(&mut st, GatewayPhase::Disconnected);
                    (sock, change)
                } else {
                    (None, None)
                }
            };
            if let Some(sock) = closing {
                sock.close_socket();
            }
            if let Some(new_state) = state_change {
                (self.on_state_changed)(new_state);
            }
            return Err(e);
        }

        await_attempt(&attempt).await
    }

    fn disconnect(self: &Arc<Self>) {
        let (closing, attempt, state_change) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            st.generation += 1;
            st.reconnect_attempts = 0;
            st.envelopes.clear();
            let prev_state = st.phase.connection_state();
            let (socket, pending, job) =
                match std::mem::replace(&mut st.phase, GatewayPhase::Disconnected) {
                    GatewayPhase::Disconnected => (None, None, None),
                    GatewayPhase::Connecting { attempt, socket }
                    | GatewayPhase::Reconnecting(ReconnectStep::Opening { attempt, socket }) => {
                        (socket, Some(attempt), None)
                    }
                    GatewayPhase::Connected { socket } => (Some(socket), None, None),
                    GatewayPhase::Reconnecting(ReconnectStep::Backoff(job)) => {
                        (None, None, Some(job))
                    }
                };
            if let Some(j) = job {
                j.abort();
            }
            let change = (prev_state != ConnectionState::Disconnected)
                .then_some(ConnectionState::Disconnected);
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
                if st.phase.pending_attempt().map(|p| p.id) != Some(attempt.id) {
                    return Err(ObscuraError::connection("Disconnected"));
                }
                st.generation += 1;
                st.generation
            };

            let sink = Arc::new(WebSocketSink::new(Arc::downgrade(self), generation));
            let handle = self.transport.open_websocket(url, sink)?;

            let (stale_handle, early_open_change) = {
                let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
                if st.generation != generation
                    || st.phase.pending_attempt().map(|p| p.id) != Some(attempt.id)
                {
                    (Some(handle), None)
                } else if attempt.opened_early.load(Ordering::SeqCst) {
                    st.reconnect_attempts = 0;
                    let change = transition(&mut st, GatewayPhase::Connected { socket: handle });
                    (None, Some(change))
                } else {
                    match &mut st.phase {
                        GatewayPhase::Connecting { socket, .. }
                        | GatewayPhase::Reconnecting(ReconnectStep::Opening { socket, .. }) => {
                            *socket = Some(handle);
                        }
                        _ => {}
                    }
                    (None, None)
                }
            };
            if let Some(h) = stale_handle {
                h.close_socket();
                return Err(ObscuraError::connection("Disconnected"));
            }
            if let Some(change) = early_open_change {
                if let Some(new_state) = change {
                    (self.on_state_changed)(new_state);
                }
                attempt.complete(Ok(()));
            }

            await_attempt(attempt).await
        }
        .await;

        if let Err(ref e) = res {
            attempt.complete(Err(e.clone()));
        }
        res
    }

    pub(crate) fn on_open(self: &Arc<Self>, generation: u64) {
        let (attempt, state_change) = {
            let mut st = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if st.generation != generation {
                return;
            }
            let (att, sock) = match &mut st.phase {
                GatewayPhase::Connecting { attempt, socket }
                | GatewayPhase::Reconnecting(ReconnectStep::Opening { attempt, socket }) => {
                    (Arc::clone(attempt), socket.take())
                }
                _ => return,
            };
            let Some(socket) = sock else {
                att.opened_early.store(true, Ordering::SeqCst);
                return;
            };
            st.reconnect_attempts = 0;
            let change = transition(&mut st, GatewayPhase::Connected { socket });
            (att, change)
        };
        if let Some(new_state) = state_change {
            (self.on_state_changed)(new_state);
        }
        attempt.complete(Ok(()));
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
            match &mut st.phase {
                GatewayPhase::Connected { socket } => (true, Some(Arc::clone(socket)), None),
                GatewayPhase::Connecting { attempt, socket }
                | GatewayPhase::Reconnecting(ReconnectStep::Opening { attempt, socket }) => {
                    (false, socket.take(), Some(Arc::clone(attempt)))
                }
                GatewayPhase::Disconnected
                | GatewayPhase::Reconnecting(ReconnectStep::Backoff(_)) => (false, None, None),
            }
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
                    if !matches!(
                        st.phase,
                        GatewayPhase::Reconnecting(ReconnectStep::Backoff(_))
                    ) {
                        return;
                    }
                    st.next_attempt_id += 1;
                    let att = Arc::new(PendingAttempt::new(st.next_attempt_id));
                    st.phase = GatewayPhase::Reconnecting(ReconnectStep::Opening {
                        attempt: Arc::clone(&att),
                        socket: None,
                    });
                    att
                };
                if let Err(e) = gw.open_attempt(&attempt).await {
                    (gw.log)(format!("GATEWAY reconnect failed: {e}"));
                    let (closing, should_reschedule) = {
                        let mut st = gw.state.lock().unwrap_or_else(|p| p.into_inner());
                        if st.phase.pending_attempt().map(|p| p.id) == Some(attempt.id) {
                            st.generation += 1;
                            (st.phase.take_opening_socket(), true)
                        } else {
                            (None, false)
                        }
                    };
                    if let Some(sock) = closing {
                        sock.close_socket();
                    }
                    if should_reschedule {
                        gw.schedule_reconnect();
                    }
                }
            });
            transition(
                &mut st,
                GatewayPhase::Reconnecting(ReconnectStep::Backoff(job)),
            )
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

fn transition(st: &mut State, next: GatewayPhase) -> Option<ConnectionState> {
    let prev_state = st.phase.connection_state();
    let next_state = next.connection_state();
    st.phase = next;
    (prev_state != next_state).then_some(next_state)
}

async fn await_attempt(attempt: &PendingAttempt) -> Result<(), ObscuraError> {
    let mut rx = attempt.tx.subscribe();
    loop {
        if let Some(res) = rx.borrow().clone() {
            return res;
        }
        if rx.changed().await.is_err() {
            return Err(ObscuraError::connection("Disconnected"));
        }
    }
}
