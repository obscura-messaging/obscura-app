use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::Mutex as AsyncMutex;

use crate::auth::AuthManager;
use crate::error::ObscuraError;
use crate::messaging::messenger::{
    DeviceSubmissionOutcome, DeviceSubmissionStatus, Messenger, PeerBundle, UserSubmission,
    parse_peer_bundles, require_consistent,
};
use crate::network::api::APIClient;
use crate::network::transport::ObscuraLogger;
use crate::proto::client::ClientMessage;
use crate::store::{DbHandle, device_store};
use crate::types::{SubmissionResult, SubmissionStatus};
use crate::wire::uuid_codec::is_uuid;

pub const MAX_ROUNDS: usize = 3;

#[derive(Debug, Clone)]
pub struct SendReport {
    pub recipients: Vec<SubmissionResult>,
    pub self_sync: Vec<SubmissionResult>,
}

impl SendReport {
    pub fn any_accepted(&self) -> bool {
        self.recipients
            .iter()
            .any(|r| r.status == SubmissionStatus::Accepted)
    }
}

impl SubmissionResult {
    pub fn failure_reason(&self) -> String {
        self.error
            .clone()
            .unwrap_or_else(|| format!("{:?}", self.status).to_ascii_lowercase())
    }
}

#[derive(Clone)]
pub struct MessageSender {
    api: APIClient,
    messenger: Messenger,
    db: DbHandle,
    logger: Arc<dyn ObscuraLogger>,
    auth: Arc<AuthManager>,
    recipient_locks: Arc<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

impl MessageSender {
    pub fn new(
        api: APIClient,
        messenger: Messenger,
        db: DbHandle,
        logger: Arc<dyn ObscuraLogger>,
        auth: Arc<AuthManager>,
    ) -> Self {
        Self {
            api,
            messenger,
            db,
            logger,
            auth,
            recipient_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn send_one(&self, user_id: &str, message: &ClientMessage) -> Vec<SubmissionResult> {
        self.send(&[user_id.to_owned()], message).await
    }

    pub async fn send_or_throw(
        &self,
        user_id: &str,
        message: &ClientMessage,
    ) -> Result<(), ObscuraError> {
        let results = self.send_one(user_id, message).await;
        if results
            .iter()
            .any(|r| r.status == SubmissionStatus::Accepted)
        {
            Ok(())
        } else {
            let reason = results
                .iter()
                .map(SubmissionResult::failure_reason)
                .collect::<Vec<_>>()
                .join(", ");
            Err(ObscuraError::send_failed(reason))
        }
    }

    pub async fn send(
        &self,
        user_ids: &[String],
        message: &ClientMessage,
    ) -> Vec<SubmissionResult> {
        let mut seen = HashSet::new();
        let users: Vec<String> = user_ids
            .iter()
            .filter(|u| seen.insert(u.as_str()))
            .cloned()
            .collect();
        if users.is_empty() {
            return Vec::new();
        }

        // Acquire per-user locks in sorted order to prevent deadlocks across overlapping batches.
        let mut sorted_users = users.clone();
        sorted_users.sort();
        let lock_arcs: Vec<Arc<AsyncMutex<()>>> = {
            let mut map = self
                .recipient_locks
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            sorted_users
                .iter()
                .map(|u| {
                    Arc::clone(
                        map.entry(u.clone())
                            .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
                    )
                })
                .collect()
        };
        let mut guards = Vec::with_capacity(lock_arcs.len());
        for arc in &lock_arcs {
            guards.push(arc.lock().await);
        }

        let mut settled: HashMap<String, Vec<SubmissionResult>> = HashMap::new();
        let mut mismatched: HashMap<String, (Vec<SubmissionResult>, Vec<String>)> = HashMap::new();
        let mut pending = users.clone();

        for _ in 0..MAX_ROUNDS {
            if pending.is_empty() {
                break;
            }
            let mut next_pending = Vec::new();
            let mut target_users: Vec<(String, bool)> = Vec::new();
            let mut batch_submissions: Vec<UserSubmission> = Vec::new();

            for user_id in &pending {
                if !is_uuid(user_id) {
                    settled.insert(
                        user_id.clone(),
                        vec![rejected(user_id, format!("Invalid user ID: {user_id}"))],
                    );
                    continue;
                }
                match self.session_targets(user_id).await {
                    Ok(None) => {
                        next_pending.push(user_id.clone());
                        continue;
                    }
                    Ok(Some((targets, is_self))) => {
                        if targets.is_empty() && !is_self {
                            settled.insert(
                                user_id.clone(),
                                vec![rejected(user_id, "No devices found")],
                            );
                            continue;
                        }
                        let mut subs = Vec::with_capacity(targets.len());
                        let mut prep_err = None;
                        for dev in targets {
                            match self.messenger.prepare_submission(&dev, message).await {
                                Ok(sub) => subs.push(UserSubmission {
                                    user_id: user_id.clone(),
                                    device_id: dev,
                                    submission: sub,
                                }),
                                Err(e) => {
                                    prep_err = Some(e);
                                    break;
                                }
                            }
                        }
                        if let Some(e) = prep_err {
                            self.logger
                                .session_establish_failed(user_id.clone(), e.to_string());
                            settled.insert(user_id.clone(), vec![rejected(user_id, e.to_string())]);
                            continue;
                        }
                        target_users.push((user_id.clone(), is_self));
                        batch_submissions.extend(subs);
                    }
                    Err(e) => {
                        self.logger
                            .session_establish_failed(user_id.clone(), e.to_string());
                        settled.insert(user_id.clone(), vec![rejected(user_id, e.to_string())]);
                    }
                }
            }

            if !target_users.is_empty() {
                let target_user_ids: Vec<String> =
                    target_users.iter().map(|(u, _)| u.clone()).collect();
                let outcome = self
                    .messenger
                    .submit(&target_user_ids, &batch_submissions)
                    .await;

                let mut invalid_by_user: BTreeMap<String, Vec<String>> = BTreeMap::new();
                for sub in &outcome.submitted {
                    if sub.status == DeviceSubmissionStatus::InvalidDevice {
                        invalid_by_user
                            .entry(sub.user_id.clone())
                            .or_default()
                            .push(sub.device_id.clone());
                    }
                }
                for (u, invalid_devs) in invalid_by_user {
                    let _ = self
                        .db
                        .write_tx(move |ctx| device_store::remove(ctx.conn, &u, &invalid_devs))
                        .await;
                }

                for (user_id, is_self) in target_users {
                    let kept: Vec<SubmissionResult> = outcome
                        .submitted
                        .iter()
                        .filter(|s| s.user_id == user_id)
                        .cloned()
                        .filter_map(DeviceSubmissionOutcome::into_submission_result)
                        .collect();

                    if let Some(missing) = outcome.mismatches.get(&user_id).cloned() {
                        let uid_clone = user_id.clone();
                        let missing_clone = missing.clone();
                        let _ = self
                            .db
                            .write_tx(move |ctx| {
                                device_store::add_many(ctx.conn, &uid_clone, &missing_clone)
                            })
                            .await;
                        mismatched.insert(user_id.clone(), (kept, missing));
                        next_pending.push(user_id);
                    } else if kept.is_empty() {
                        if is_self {
                            settled.insert(user_id, Vec::new());
                        } else {
                            settled.insert(
                                user_id.clone(),
                                vec![rejected(&user_id, "No devices found")],
                            );
                        }
                    } else {
                        settled.insert(user_id, kept);
                    }
                }
            }

            pending = next_pending;
        }

        for user_id in pending {
            if let Some((kept, missing)) = mismatched.remove(&user_id) {
                let err_msg = format!(
                    "Device mismatch after {MAX_ROUNDS} rounds; missing [{}]",
                    missing.join(", ")
                );
                if kept.is_empty() {
                    settled.insert(user_id.clone(), vec![rejected(&user_id, err_msg)]);
                } else {
                    settled.insert(
                        user_id,
                        kept.into_iter()
                            .map(|mut r| {
                                r.error = Some(err_msg.clone());
                                r
                            })
                            .collect(),
                    );
                }
            } else {
                settled.insert(
                    user_id.clone(),
                    vec![rejected(&user_id, "Sessions could not be established")],
                );
            }
        }

        drop(guards);

        users
            .iter()
            .filter_map(|u| settled.remove(u))
            .flatten()
            .collect()
    }

    async fn targets_of(&self, user_id: &str) -> Result<(Vec<String>, bool), ObscuraError> {
        let uid = user_id.to_owned();
        let all = self
            .db
            .read(move |conn| device_store::devices_of(conn, &uid))
            .await?;
        let self_dev = self.auth.device_id();
        let is_self = self_dev.as_ref().is_some_and(|s| all.contains(s));
        let targets = all
            .into_iter()
            .filter(|d| self_dev.as_deref() != Some(d.as_str()))
            .collect();
        Ok((targets, is_self))
    }

    async fn session_targets(
        &self,
        user_id: &str,
    ) -> Result<Option<(Vec<String>, bool)>, ObscuraError> {
        let (existing_targets, is_self) = self.targets_of(user_id).await?;
        if existing_targets.is_empty() && !is_self {
            let bundles = self.fetch_all(user_id).await?;
            self.establish(user_id, bundles).await?;
        }

        let (current_targets, _) = self.targets_of(user_id).await?;
        let mut missing_bundles = Vec::new();
        for dev in current_targets {
            if !self.messenger.has_session(&dev).await?
                && let Some(bundle) = self.fetch_one(user_id, &dev).await?
            {
                missing_bundles.push(bundle);
            }
        }
        self.establish(user_id, missing_bundles).await?;

        let (final_targets, is_self) = self.targets_of(user_id).await?;
        for dev in &final_targets {
            if !self.messenger.has_session(dev).await? {
                return Ok(None);
            }
        }
        Ok(Some((final_targets, is_self)))
    }

    async fn fetch_all(&self, user_id: &str) -> Result<Vec<PeerBundle>, ObscuraError> {
        let self_dev = self.auth.device_id();
        match self.api.fetch_pre_key_bundles(user_id).await {
            Ok(values) => {
                let bundles = parse_peer_bundles(values)?;
                Ok(bundles
                    .into_iter()
                    .filter(|b| self_dev.as_deref() != Some(b.device_id.as_str()))
                    .collect())
            }
            Err(ObscuraError::Http { status: 404, .. }) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    async fn fetch_one(
        &self,
        user_id: &str,
        device_id: &str,
    ) -> Result<Option<PeerBundle>, ObscuraError> {
        match self.api.fetch_pre_key_bundle(user_id, device_id).await {
            Ok(val) => {
                let bundle = PeerBundle::try_from(val)?;
                if bundle.device_id != device_id {
                    return Err(ObscuraError::protocol(format!(
                        "Bundle for {device_id} names device {}",
                        bundle.device_id
                    )));
                }
                Ok(Some(bundle))
            }
            Err(ObscuraError::Http { status: 404, .. }) => {
                let uid = user_id.to_owned();
                let dev = device_id.to_owned();
                self.db
                    .write_tx(move |ctx| device_store::remove(ctx.conn, &uid, &[dev]))
                    .await?;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    async fn establish(&self, user_id: &str, bundles: Vec<PeerBundle>) -> Result<(), ObscuraError> {
        if bundles.is_empty() {
            return Ok(());
        }
        require_consistent(&bundles)?;
        for peer in bundles {
            self.messenger
                .establish_session_with_device(user_id, peer)
                .await?;
        }
        Ok(())
    }
}

fn rejected(user_id: &str, error: impl Into<String>) -> SubmissionResult {
    SubmissionResult {
        user_id: user_id.to_owned(),
        device_id: None,
        status: SubmissionStatus::Rejected,
        error: Some(error.into()),
    }
}
