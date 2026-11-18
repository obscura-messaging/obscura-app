use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::types::TypingState;

pub const EXPIRE_MS: u64 = 5_000;
pub const THROTTLE_MS: i64 = 2_000;

pub type PeerTypingCallback = Arc<dyn Fn(&str, bool) + Send + Sync>;

struct Inner {
    // context_id -> sender_device_id -> (sender_user_id, generation)
    typing: HashMap<String, HashMap<String, (String, u64)>>,
    expiries: HashMap<(String, String), (u64, JoinHandle<()>)>,
    last_sent: HashMap<(String, TypingState), i64>,
    // peer_user_id -> (context_id, last_emitted_typing)
    observed_peers: BTreeMap<String, (String, bool)>,
    next_generation: u64,
    on_peer_typing_changed: Option<PeerTypingCallback>,
}

#[derive(Clone)]
pub struct TypingTracker {
    inner: Arc<Mutex<Inner>>,
    expire_ms: u64,
}

impl Default for TypingTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl TypingTracker {
    pub fn new() -> Self {
        Self::with_expiry(EXPIRE_MS, None)
    }

    pub fn with_listener(callback: PeerTypingCallback) -> Self {
        Self::with_expiry(EXPIRE_MS, Some(callback))
    }

    pub fn with_expiry(expire_ms: u64, on_peer_typing_changed: Option<PeerTypingCallback>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                typing: HashMap::new(),
                expiries: HashMap::new(),
                last_sent: HashMap::new(),
                observed_peers: BTreeMap::new(),
                next_generation: 0,
                on_peer_typing_changed,
            })),
            expire_ms,
        }
    }

    pub fn should_send(&self, context_id: &str, state: TypingState, now_ms: i64) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let key = (context_id.to_owned(), state);
        if let Some(&last) = inner.last_sent.get(&key)
            && now_ms.saturating_sub(last) < THROTTLE_MS
        {
            return false;
        }
        inner.last_sent.insert(key, now_ms);
        true
    }

    pub fn started(&self, context_id: &str, sender_user_id: &str, sender_device_id: &str) {
        let notifications = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.next_generation += 1;
            let generation = inner.next_generation;
            let key = (context_id.to_owned(), sender_device_id.to_owned());
            if let Some((_, old_handle)) = inner.expiries.remove(&key) {
                old_handle.abort();
            }
            inner
                .typing
                .entry(context_id.to_owned())
                .or_default()
                .insert(
                    sender_device_id.to_owned(),
                    (sender_user_id.to_owned(), generation),
                );

            let tracker = self.clone();
            let ctx = context_id.to_owned();
            let dev = sender_device_id.to_owned();
            let delay_ms = self.expire_ms;
            let handle = crate::runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                tracker.expire_device(&ctx, &dev, generation);
            });
            inner.expiries.insert(key, (generation, handle));
            collect_notifications(&mut inner, context_id)
        };
        dispatch_notifications(notifications);
    }

    pub fn stopped(&self, context_id: &str, sender_device_id: &str) {
        let notifications = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let key = (context_id.to_owned(), sender_device_id.to_owned());
            if let Some((_, old_handle)) = inner.expiries.remove(&key) {
                old_handle.abort();
            }
            remove_device(&mut inner, context_id, sender_device_id);
            collect_notifications(&mut inner, context_id)
        };
        dispatch_notifications(notifications);
    }

    fn expire_device(&self, context_id: &str, sender_device_id: &str, generation: u64) {
        let notifications = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let key = (context_id.to_owned(), sender_device_id.to_owned());
            if inner.expiries.get(&key).map(|(g, _)| *g) != Some(generation) {
                return;
            }
            inner.expiries.remove(&key);
            remove_device(&mut inner, context_id, sender_device_id);
            collect_notifications(&mut inner, context_id)
        };
        dispatch_notifications(notifications);
    }

    pub fn active_users(&self, context_id: &str) -> Vec<String> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        active_users_locked(&inner, context_id)
    }

    pub fn observe_peer(&self, peer_user_id: &str, context_id: &str) {
        let notification = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let is_typing = active_users_locked(&inner, context_id)
                .iter()
                .any(|u| u == peer_user_id);
            inner
                .observed_peers
                .insert(peer_user_id.to_owned(), (context_id.to_owned(), is_typing));
            inner
                .on_peer_typing_changed
                .clone()
                .map(|cb| (cb, peer_user_id.to_owned(), is_typing))
        };
        if let Some((cb, peer, is_typing)) = notification {
            cb(&peer, is_typing);
        }
    }

    pub fn stop_observing_peer(&self, peer_user_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.observed_peers.remove(peer_user_id);
    }

    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        for (_, (_, handle)) in inner.expiries.drain() {
            handle.abort();
        }
        inner.typing.clear();
        inner.last_sent.clear();
        inner.observed_peers.clear();
    }
}

fn active_users_locked(inner: &Inner, context_id: &str) -> Vec<String> {
    let Some(devices) = inner.typing.get(context_id) else {
        return Vec::new();
    };
    let mut users: Vec<String> = devices.values().map(|(u, _)| u.clone()).collect();
    users.sort();
    users.dedup();
    users
}

fn remove_device(inner: &mut Inner, context_id: &str, sender_device_id: &str) {
    if let Some(devices) = inner.typing.get_mut(context_id) {
        devices.remove(sender_device_id);
        if devices.is_empty() {
            inner.typing.remove(context_id);
        }
    }
}

fn collect_notifications(
    inner: &mut Inner,
    context_id: &str,
) -> Vec<(PeerTypingCallback, String, bool)> {
    let Some(cb) = inner.on_peer_typing_changed.clone() else {
        return Vec::new();
    };
    let active = active_users_locked(inner, context_id);
    let mut out = Vec::new();
    for (peer_user_id, (obs_ctx, last_state)) in inner.observed_peers.iter_mut() {
        if obs_ctx == context_id {
            let now_typing = active.iter().any(|u| u == peer_user_id);
            if *last_state != now_typing {
                *last_state = now_typing;
                out.push((cb.clone(), peer_user_id.clone(), now_typing));
            }
        }
    }
    out
}

fn dispatch_notifications(notifications: Vec<(PeerTypingCallback, String, bool)>) {
    for (cb, peer, is_typing) in notifications {
        cb(&peer, is_typing);
    }
}

pub fn typing_conv_id(user_a: &str, user_b: &str) -> String {
    if user_a <= user_b {
        format!("{user_a}_{user_b}")
    } else {
        format!("{user_b}_{user_a}")
    }
}
