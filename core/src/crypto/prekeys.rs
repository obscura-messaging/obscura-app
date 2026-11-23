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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreKeyBundleJson {
    pub device_id: String,
    pub registration_id: u32,
    pub identity_key: String,
    pub signed_pre_key: SignedPreKeyJson,
    pub kyber_pre_key: KyberPreKeyJson,
    #[serde(default)]
    pub one_time_pre_key: Option<OneTimePreKeyJson>,
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
    pub signed_pre_key: SignedPreKeyRecord,
    pub last_resort_kyber_pre_key: KyberPreKeyRecord,
    pub one_time_pre_keys: Vec<PreKeyRecord>,
    pub kyber_pre_keys: Vec<KyberPreKeyRecord>,
    pub state: PreKeyState,
}

impl ProvisioningKeys {
    pub fn to_device_keys(&self) -> Result<DeviceKeysJson, ObscuraError> {
        Ok(DeviceKeysJson {
            identity_key: STANDARD.encode(self.identity.public_key().serialize()),
            registration_id: self.registration_id,
            signed_pre_key: signed_to_json(&self.signed_pre_key)?,
            last_resort_kyber_pre_key: kyber_to_json(&self.last_resort_kyber_pre_key)?,
            one_time_pre_keys: self
                .one_time_pre_keys
                .iter()
                .map(one_time_to_json)
                .collect::<Result<Vec<_>, _>>()?,
            kyber_pre_keys: self
                .kyber_pre_keys
                .iter()
                .map(kyber_to_json)
                .collect::<Result<Vec<_>, _>>()?,
        })
    }
}

#[derive(Clone)]
pub struct PreKeyRefill {
    pub signed_pre_key: Option<SignedPreKeyRecord>,
    pub last_resort_kyber_pre_key: Option<KyberPreKeyRecord>,
    pub one_time_pre_keys: Vec<PreKeyRecord>,
    pub kyber_pre_keys: Vec<KyberPreKeyRecord>,
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
                .map(signed_to_json)
                .transpose()?,
            last_resort_kyber_pre_key: self
                .last_resort_kyber_pre_key
                .as_ref()
                .map(kyber_to_json)
                .transpose()?,
            one_time_pre_keys: self
                .one_time_pre_keys
                .iter()
                .map(one_time_to_json)
                .collect::<Result<Vec<_>, _>>()?,
            kyber_pre_keys: self
                .kyber_pre_keys
                .iter()
                .map(kyber_to_json)
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
    let one_time_pre_keys: Vec<PreKeyRecord> = one_time_ids
        .iter()
        .map(|&id| {
            let pair = KeyPair::generate(&mut rand::rng());
            PreKeyRecord::new(id.into(), &pair)
        })
        .collect();
    let kyber_pre_keys = kyber_ids
        .iter()
        .map(|&id| generate_kyber_pre_key(identity.private_key(), id, now_ms))
        .collect::<Result<Vec<_>, _>>()?;

    let state = PreKeyState {
        next_signed_id: next_id(signed_id),
        next_one_time_id: next_id(*one_time_ids.last().unwrap_or(&one_time_start)),
        next_kyber_id: next_id(*kyber_ids.last().unwrap_or(&last_resort_id)),
        active_signed_id: signed_id,
        active_last_resort_id: last_resort_id,
        rotated_at: now_ms,
        synced_at: now_ms,
    };

    Ok(ProvisioningKeys {
        identity,
        registration_id,
        signed_pre_key,
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
    crate::runtime::spawn_blocking(move || generate_provisioning_keys_sync(identity, now_ms))
        .await
        .map_err(|e| ObscuraError::storage(format!("Pre-key generation task failed: {e}")))?
}

pub fn install(conn: &Connection, keys: &ProvisioningKeys) -> Result<(), ObscuraError> {
    SignalStore::install_identity(conn, &keys.identity, keys.registration_id)?;
    SignalStore::store_signed_pre_key(
        conn,
        signed_pre_key_id(&keys.signed_pre_key)?,
        &keys.signed_pre_key,
    )?;
    SignalStore::store_kyber_pre_key(
        conn,
        kyber_pre_key_id(&keys.last_resort_kyber_pre_key)?,
        &keys.last_resort_kyber_pre_key,
        true,
    )?;
    for rec in &keys.one_time_pre_keys {
        SignalStore::store_pre_key(conn, pre_key_id(rec)?, rec)?;
    }
    for rec in &keys.kyber_pre_keys {
        SignalStore::store_kyber_pre_key(conn, kyber_pre_key_id(rec)?, rec, false)?;
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
    let (state, identity) = db
        .read(|conn| {
            let state = SignalStore::pre_key_state(conn)?
                .ok_or_else(|| ObscuraError::storage("Pre-keys not provisioned"))?;
            let (identity, _) = SignalStore::get_local_identity(conn)?
                .ok_or_else(|| ObscuraError::storage("Identity not initialized"))?;
            Ok((state, identity))
        })
        .await?;

    let state_snapshot = state.clone();
    let (refill, updated) = crate::runtime::spawn_blocking(move || -> Result<_, ObscuraError> {
        let priv_key = identity.private_key();
        let mut updated = state;

        let mut signed = None;
        let mut last_resort = None;
        if is_due(updated.rotated_at, now_ms) {
            let s_id = updated.next_signed_id;
            let lr_id = updated.next_kyber_id;
            let s_rec = generate_signed_pre_key(priv_key, s_id, now_ms)?;
            let lr_rec = generate_kyber_pre_key(priv_key, lr_id, now_ms)?;
            updated.next_signed_id = next_id(s_id);
            updated.next_kyber_id = next_id(lr_id);
            signed = Some(s_rec);
            last_resort = Some(lr_rec);
        }

        let one_time = if counts.one_time < ONE_TIME_MINIMUM {
            let batch_ids = ids(updated.next_one_time_id, BATCH_SIZE);
            if let Some(&last) = batch_ids.last() {
                updated.next_one_time_id = next_id(last);
            }
            batch_ids
                .into_iter()
                .map(|id| {
                    let pair = KeyPair::generate(&mut rand::rng());
                    PreKeyRecord::new(id.into(), &pair)
                })
                .collect()
        } else {
            Vec::new()
        };

        let kyber = if counts.kyber < ONE_TIME_MINIMUM {
            let batch_ids = ids(updated.next_kyber_id, BATCH_SIZE);
            if let Some(&last) = batch_ids.last() {
                updated.next_kyber_id = next_id(last);
            }
            batch_ids
                .into_iter()
                .map(|id| generate_kyber_pre_key(priv_key, id, now_ms))
                .collect::<Result<Vec<_>, _>>()?
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
        if let Some(ref rec) = refill_for_db.signed_pre_key {
            SignalStore::store_signed_pre_key(ctx.conn, signed_pre_key_id(rec)?, rec)?;
        }
        if let Some(ref rec) = refill_for_db.last_resort_kyber_pre_key {
            SignalStore::store_kyber_pre_key(ctx.conn, kyber_pre_key_id(rec)?, rec, true)?;
        }
        if !refill_for_db.one_time_pre_keys.is_empty() {
            SignalStore::mark_one_time_ec_pre_keys_stale(ctx.conn, now_ms)?;
            for rec in &refill_for_db.one_time_pre_keys {
                SignalStore::store_pre_key(ctx.conn, pre_key_id(rec)?, rec)?;
            }
        }
        if !refill_for_db.kyber_pre_keys.is_empty() {
            SignalStore::mark_one_time_kyber_pre_keys_stale(ctx.conn, now_ms)?;
            for rec in &refill_for_db.kyber_pre_keys {
                SignalStore::store_kyber_pre_key(ctx.conn, kyber_pre_key_id(rec)?, rec, false)?;
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
    let signed_id = refill
        .signed_pre_key
        .as_ref()
        .map(signed_pre_key_id)
        .transpose()?;
    let last_resort_id = refill
        .last_resort_kyber_pre_key
        .as_ref()
        .map(kyber_pre_key_id)
        .transpose()?;
    db.write_tx(move |ctx| {
        let mut state = SignalStore::pre_key_state(ctx.conn)?
            .ok_or_else(|| ObscuraError::storage("Pre-keys not provisioned"))?;
        if let (Some(s_id), Some(lr_id)) = (signed_id, last_resort_id) {
            state.active_signed_id = s_id;
            state.active_last_resort_id = lr_id;
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

fn pre_key_id(rec: &PreKeyRecord) -> Result<u32, ObscuraError> {
    Ok(u32::from(rec.id().map_err(map_signal_error)?))
}

fn signed_pre_key_id(rec: &SignedPreKeyRecord) -> Result<u32, ObscuraError> {
    Ok(u32::from(rec.id().map_err(map_signal_error)?))
}

fn kyber_pre_key_id(rec: &KyberPreKeyRecord) -> Result<u32, ObscuraError> {
    Ok(u32::from(rec.id().map_err(map_signal_error)?))
}

fn signed_to_json(rec: &SignedPreKeyRecord) -> Result<SignedPreKeyJson, ObscuraError> {
    let key_id = signed_pre_key_id(rec)?;
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    let sig = rec.signature().map_err(map_signal_error)?;
    Ok(SignedPreKeyJson {
        key_id,
        public_key: STANDARD.encode(pub_key),
        signature: STANDARD.encode(sig),
    })
}

fn kyber_to_json(rec: &KyberPreKeyRecord) -> Result<KyberPreKeyJson, ObscuraError> {
    let key_id = kyber_pre_key_id(rec)?;
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    let sig = rec.signature().map_err(map_signal_error)?;
    Ok(KyberPreKeyJson {
        key_id,
        public_key: STANDARD.encode(pub_key),
        signature: STANDARD.encode(sig),
    })
}

fn one_time_to_json(rec: &PreKeyRecord) -> Result<OneTimePreKeyJson, ObscuraError> {
    let key_id = pre_key_id(rec)?;
    let pub_key = rec.public_key().map_err(map_signal_error)?.serialize();
    Ok(OneTimePreKeyJson {
        key_id,
        public_key: STANDARD.encode(pub_key),
    })
}
