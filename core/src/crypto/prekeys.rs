use base64::{Engine as _, engine::general_purpose::STANDARD};
use libsignal_protocol::{
    GenericSignedPreKey, IdentityKeyPair, KeyPair, KyberPreKeyRecord, PreKeyRecord, PrivateKey,
    SignedPreKeyRecord, Timestamp, kem,
};
use rand::Rng;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::ObscuraError;
use crate::store::DbHandle;
use crate::store::signal_store::{PreKeyState, SignalStore, map_signal_error};

pub const BATCH_SIZE: u32 = 100;
pub const ONE_TIME_MINIMUM: u32 = 10;
pub const REFRESH_INTERVAL_MS: i64 = 2 * 24 * 60 * 60 * 1000;
pub const CHECK_INTERVAL_MS: u64 = 6 * 60 * 60 * 1000;
pub const SYNC_SPACING_MS: u64 = 30 * 1000;
pub const MEDIUM_MAX_VALUE: u32 = 0xFFFFFF;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignedPreKeyJson {
    pub key_id: u32,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OneTimePreKeyJson {
    pub key_id: u32,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KyberPreKeyJson {
    pub key_id: u32,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceKeysJson {
    pub identity_key: String,
    pub registration_id: u32,
    pub signed_pre_key: SignedPreKeyJson,
    pub last_resort_kyber_pre_key: KyberPreKeyJson,
    pub one_time_pre_keys: Vec<OneTimePreKeyJson>,
    pub kyber_pre_keys: Vec<KyberPreKeyJson>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreKeyUploadJson {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_pre_key: Option<SignedPreKeyJson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_resort_kyber_pre_key: Option<KyberPreKeyJson>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub one_time_pre_keys: Vec<OneTimePreKeyJson>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub kyber_pre_keys: Vec<KyberPreKeyJson>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreKeyCounts {
    #[serde(rename = "oneTimePreKeyCount")]
    pub one_time: u32,
    #[serde(rename = "kyberPreKeyCount")]
    pub kyber: u32,
}

#[derive(Clone)]
pub struct ProvisioningKeys {
    pub identity: IdentityKeyPair,
    pub registration_id: u32,
    pub signed_pre_key_id: u32,
    pub signed_pre_key: SignedPreKeyRecord,
    pub last_resort_id: u32,
    pub last_resort_kyber_pre_key: KyberPreKeyRecord,
    pub one_time_pre_keys: Vec<(u32, PreKeyRecord)>,
    pub kyber_pre_keys: Vec<(u32, KyberPreKeyRecord)>,
    pub state: PreKeyState,
}

impl ProvisioningKeys {
    pub fn to_device_keys(&self) -> Result<DeviceKeysJson, ObscuraError> {
        Ok(DeviceKeysJson {
            identity_key: STANDARD.encode(self.identity.public_key().serialize()),
            registration_id: self.registration_id,
            signed_pre_key: signed_to_json(self.signed_pre_key_id, &self.signed_pre_key)?,
            last_resort_kyber_pre_key: kyber_to_json(
                self.last_resort_id,
                &self.last_resort_kyber_pre_key,
            )?,
            one_time_pre_keys: self
                .one_time_pre_keys
                .iter()
                .map(|(id, r)| one_time_to_json(*id, r))
                .collect::<Result<Vec<_>, _>>()?,
            kyber_pre_keys: self
                .kyber_pre_keys
                .iter()
                .map(|(id, r)| kyber_to_json(*id, r))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

#[derive(Clone)]
pub struct PreKeyRefill {
    pub signed_pre_key: Option<(u32, SignedPreKeyRecord)>,
    pub last_resort_kyber_pre_key: Option<(u32, KyberPreKeyRecord)>,
    pub one_time_pre_keys: Vec<(u32, PreKeyRecord)>,
    pub kyber_pre_keys: Vec<(u32, KyberPreKeyRecord)>,
}

impl PreKeyRefill {
    pub fn is_empty(&self) -> bool {
        self.signed_pre_key.is_none()
            && self.last_resort_kyber_pre_key.is_none()
            && self.one_time_pre_keys.is_empty()
            && self.kyber_pre_keys.is_empty()
    }

    pub fn to_upload(&self) -> Result<PreKeyUploadJson, ObscuraError> {
        Ok(PreKeyUploadJson {
            signed_pre_key: self
                .signed_pre_key
                .as_ref()
                .map(|(id, r)| signed_to_json(*id, r))
                .transpose()?,
            last_resort_kyber_pre_key: self
                .last_resort_kyber_pre_key
                .as_ref()
                .map(|(id, r)| kyber_to_json(*id, r))
                .transpose()?,
            one_time_pre_keys: self
                .one_time_pre_keys
                .iter()
                .map(|(id, r)| one_time_to_json(*id, r))
                .collect::<Result<Vec<_>, _>>()?,
            kyber_pre_keys: self
                .kyber_pre_keys
                .iter()
                .map(|(id, r)| kyber_to_json(*id, r))
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

pub fn generate_provisioning_keys_sync(
    identity: IdentityKeyPair,
    now_ms: i64,
) -> Result<ProvisioningKeys, ObscuraError> {
    let mut rng = rand::rng();
    let signed_id = rng.random_range(0..MEDIUM_MAX_VALUE);
    let one_time_start = rng.random_range(0..MEDIUM_MAX_VALUE);
    let kyber_start = rng.random_range(0..MEDIUM_MAX_VALUE);
    let last_resort_id = kyber_start;
    let kyber_ids = ids(next_id(last_resort_id), BATCH_SIZE);
    let one_time_ids = ids(one_time_start, BATCH_SIZE);
    let registration_id: u32 = rng.random_range(1..=16380);

    let signed_pre_key = generate_signed_pre_key(identity.private_key(), signed_id, now_ms)?;
    let last_resort_kyber_pre_key =
        generate_kyber_pre_key(identity.private_key(), last_resort_id, now_ms)?;
    let one_time_pre_keys: Vec<(u32, PreKeyRecord)> = one_time_ids
        .iter()
        .map(|&id| {
            let pair = KeyPair::generate(&mut rand::rng());
            (id, PreKeyRecord::new(id.into(), &pair))
        })
        .collect();
    let mut kyber_pre_keys = Vec::with_capacity(kyber_ids.len());
    for &id in &kyber_ids {
        kyber_pre_keys.push((
            id,
            generate_kyber_pre_key(identity.private_key(), id, now_ms)?,
        ));
    }

    let state = PreKeyState {
        next_signed_id: next_id(signed_id) as i64,
        next_one_time_id: next_id(*one_time_ids.last().unwrap_or(&one_time_start)) as i64,
        next_kyber_id: next_id(*kyber_ids.last().unwrap_or(&last_resort_id)) as i64,
        active_signed_id: signed_id as i64,
        active_last_resort_id: last_resort_id as i64,
        rotated_at: now_ms,
        synced_at: now_ms,
    };

    Ok(ProvisioningKeys {
        identity,
        registration_id,
        signed_pre_key_id: signed_id,
        signed_pre_key,
        last_resort_id,
        last_resort_kyber_pre_key,
        one_time_pre_keys,
        kyber_pre_keys,
        state,
    })
}

pub async fn generate_provisioning_keys(
    identity: IdentityKeyPair,
    now_ms: i64,
) -> Result<ProvisioningKeys, ObscuraError> {
    let identity_bytes = identity.serialize().into_vec();
    crate::runtime::spawn_blocking(move || {
        let pair = IdentityKeyPair::try_from(&identity_bytes[..]).map_err(map_signal_error)?;
        generate_provisioning_keys_sync(pair, now_ms)
    })
    .await
    .map_err(|e| ObscuraError::storage(format!("Pre-key generation task failed: {e}")))?
}

pub fn install(conn: &Connection, keys: &ProvisioningKeys) -> Result<(), ObscuraError> {
    SignalStore::install_identity(conn, &keys.identity, keys.registration_id)?;
    SignalStore::store_signed_pre_key(conn, keys.signed_pre_key_id, &keys.signed_pre_key)?;
    SignalStore::store_kyber_pre_key(
        conn,
        keys.last_resort_id,
        &keys.last_resort_kyber_pre_key,
        true,
    )?;
    for (id, rec) in &keys.one_time_pre_keys {
        SignalStore::store_pre_key(conn, *id, rec)?;
    }
    for (id, rec) in &keys.kyber_pre_keys {
        SignalStore::store_kyber_pre_key(conn, *id, rec, false)?;
    }
    SignalStore::save_pre_key_state(conn, &keys.state)
}

pub async fn is_sync_due(db: &DbHandle, now_ms: i64) -> Result<bool, ObscuraError> {
    db.read(move |conn| {
        Ok(SignalStore::pre_key_state(conn)?
            .map(|s| is_due(s.synced_at, now_ms))
            .unwrap_or(false))
    })
    .await
}

pub async fn prepare_refill(
    db: &DbHandle,
    counts: PreKeyCounts,
    now_ms: i64,
) -> Result<PreKeyRefill, ObscuraError> {
    let (state, identity_bytes) = db
        .read(|conn| {
            let state = SignalStore::pre_key_state(conn)?
                .ok_or_else(|| ObscuraError::storage("Pre-keys not provisioned"))?;
            let (identity, _) = SignalStore::get_local_identity(conn)?
                .ok_or_else(|| ObscuraError::storage("Identity not initialized"))?;
            Ok((state, identity.serialize().into_vec()))
        })
        .await?;

    let state_snapshot = state.clone();
    let (refill, updated) = crate::runtime::spawn_blocking(move || -> Result<_, ObscuraError> {
        let identity = IdentityKeyPair::try_from(&identity_bytes[..]).map_err(map_signal_error)?;
        let priv_key = identity.private_key();
        let mut updated = state;

        let mut signed = None;
        let mut last_resort = None;
        if is_due(updated.rotated_at, now_ms) {
            let s_id = updated.next_signed_id as u32;
            let lr_id = updated.next_kyber_id as u32;
            let s_rec = generate_signed_pre_key(priv_key, s_id, now_ms)?;
            let lr_rec = generate_kyber_pre_key(priv_key, lr_id, now_ms)?;
            updated.next_signed_id = next_id(s_id) as i64;
            updated.next_kyber_id = next_id(lr_id) as i64;
            signed = Some((s_id, s_rec));
            last_resort = Some((lr_id, lr_rec));
        }

        let one_time = if counts.one_time < ONE_TIME_MINIMUM {
            let batch_ids = ids(updated.next_one_time_id as u32, BATCH_SIZE);
            if let Some(&last) = batch_ids.last() {
                updated.next_one_time_id = next_id(last) as i64;
            }
            batch_ids
                .into_iter()
                .map(|id| {
                    let pair = KeyPair::generate(&mut rand::rng());
                    (id, PreKeyRecord::new(id.into(), &pair))
                })
                .collect()
        } else {
            Vec::new()
        };

        let kyber = if counts.kyber < ONE_TIME_MINIMUM {
            let batch_ids = ids(updated.next_kyber_id as u32, BATCH_SIZE);
            if let Some(&last) = batch_ids.last() {
                updated.next_kyber_id = next_id(last) as i64;
            }
            let mut out = Vec::with_capacity(batch_ids.len());
            for id in batch_ids {
                out.push((id, generate_kyber_pre_key(priv_key, id, now_ms)?));
            }
            out
        } else {
            Vec::new()
        };

        Ok((
            PreKeyRefill {
                signed_pre_key: signed,
                last_resort_kyber_pre_key: last_resort,
                one_time_pre_keys: one_time,
                kyber_pre_keys: kyber,
            },
            updated,
        ))
    })
    .await
    .map_err(|e| ObscuraError::storage(format!("Pre-key refill generation failed: {e}")))??;

    let refill_for_db = refill.clone();
    db.write_tx(move |ctx| {
        let current = SignalStore::pre_key_state(ctx.conn)?
            .ok_or_else(|| ObscuraError::storage("Pre-keys not provisioned"))?;
        if current != state_snapshot {
            return Err(ObscuraError::storage("Pre-key state changed during a sync"));
        }
        if let Some((id, ref rec)) = refill_for_db.signed_pre_key {
            SignalStore::store_signed_pre_key(ctx.conn, id, rec)?;
        }
        if let Some((id, ref rec)) = refill_for_db.last_resort_kyber_pre_key {
            SignalStore::store_kyber_pre_key(ctx.conn, id, rec, true)?;
        }
        if !refill_for_db.one_time_pre_keys.is_empty() {
            SignalStore::mark_one_time_ec_pre_keys_stale(ctx.conn, now_ms)?;
            for (id, rec) in &refill_for_db.one_time_pre_keys {
                SignalStore::store_pre_key(ctx.conn, *id, rec)?;
            }
        }
        if !refill_for_db.kyber_pre_keys.is_empty() {
            SignalStore::mark_one_time_kyber_pre_keys_stale(ctx.conn, now_ms)?;
            for (id, rec) in &refill_for_db.kyber_pre_keys {
                SignalStore::store_kyber_pre_key(ctx.conn, *id, rec, false)?;
            }
        }
        SignalStore::save_pre_key_state(ctx.conn, &updated)
    })
    .await?;

    Ok(refill)
}

pub async fn confirm_refill(
    db: &DbHandle,
    refill: &PreKeyRefill,
    now_ms: i64,
) -> Result<(), ObscuraError> {
    let signed_id = refill.signed_pre_key.as_ref().map(|(id, _)| *id);
    let last_resort_id = refill.last_resort_kyber_pre_key.as_ref().map(|(id, _)| *id);
    db.write_tx(move |ctx| {
        let mut state = SignalStore::pre_key_state(ctx.conn)?
            .ok_or_else(|| ObscuraError::storage("Pre-keys not provisioned"))?;
        if let (Some(s_id), Some(lr_id)) = (signed_id, last_resort_id) {
            state.active_signed_id = s_id as i64;
            state.active_last_resort_id = lr_id as i64;
            state.rotated_at = now_ms;
        }
        state.synced_at = now_ms;
        SignalStore::save_pre_key_state(ctx.conn, &state)?;
        SignalStore::clean_pre_keys(ctx.conn, now_ms)
    })
    .await
}

fn is_due(since_ms: i64, now_ms: i64) -> bool {
    now_ms - since_ms >= REFRESH_INTERVAL_MS || now_ms < since_ms
}

pub fn next_id(id: u32) -> u32 {
    (id + 1) % MEDIUM_MAX_VALUE
}

pub fn ids(start: u32, count: u32) -> Vec<u32> {
    (0..count).map(|i| (start + i) % MEDIUM_MAX_VALUE).collect()
}

pub fn generate_signed_pre_key(
    identity: &PrivateKey,
    id: u32,
    now_ms: i64,
) -> Result<SignedPreKeyRecord, ObscuraError> {
    let mut rng = rand::rng();
    let pair = KeyPair::generate(&mut rng);
    let sig = identity
        .calculate_signature(&pair.public_key.serialize(), &mut rng)
        .map_err(|e| ObscuraError::protocol(e.to_string()))?;
    Ok(SignedPreKeyRecord::new(
        id.into(),
        Timestamp::from_epoch_millis(now_ms.max(0) as u64),
        &pair,
        &sig,
    ))
}

pub fn generate_kyber_pre_key(
    identity: &PrivateKey,
    id: u32,
    now_ms: i64,
) -> Result<KyberPreKeyRecord, ObscuraError> {
    let mut rng = rand::rng();
    let pair = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut rng);
    let sig = identity
        .calculate_signature(&pair.public_key.serialize(), &mut rng)
        .map_err(|e| ObscuraError::protocol(e.to_string()))?;
    Ok(KyberPreKeyRecord::new(
        id.into(),
        Timestamp::from_epoch_millis(now_ms.max(0) as u64),
        &pair,
        &sig,
    ))
}

fn signed_to_json(id: u32, rec: &SignedPreKeyRecord) -> Result<SignedPreKeyJson, ObscuraError> {
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    let sig = rec.signature().map_err(map_signal_error)?;
    Ok(SignedPreKeyJson {
        key_id: id,
        public_key: STANDARD.encode(pub_key),
        signature: STANDARD.encode(sig),
    })
}

fn kyber_to_json(id: u32, rec: &KyberPreKeyRecord) -> Result<KyberPreKeyJson, ObscuraError> {
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    let sig = rec.signature().map_err(map_signal_error)?;
    Ok(KyberPreKeyJson {
        key_id: id,
        public_key: STANDARD.encode(pub_key),
        signature: STANDARD.encode(sig),
    })
}

fn one_time_to_json(id: u32, rec: &PreKeyRecord) -> Result<OneTimePreKeyJson, ObscuraError> {
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    Ok(OneTimePreKeyJson {
        key_id: id,
        public_key: STANDARD.encode(pub_key),
    })
}
