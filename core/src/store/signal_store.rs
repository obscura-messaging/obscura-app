use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use libsignal_protocol::{
    CiphertextMessageType, Direction, GenericSignedPreKey, IdentityChange, IdentityKey,
    IdentityKeyPair, IdentityKeyStore, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyId, PreKeyRecord, PreKeyStore, ProtocolAddress, PublicKey, SessionRecord, SessionStore,
    SignalProtocolError, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore,
};
use rusqlite::{Connection, OptionalExtension, params};
use subtle::ConstantTimeEq;

use crate::error::ObscuraError;
use crate::store::PostCommitEffect;

pub const ARCHIVE_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const STALE_ONE_TIME_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
pub const MIN_ONE_TIME_KEPT: i64 = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreKeyState {
    pub next_signed_id: i64,
    pub next_one_time_id: i64,
    pub next_kyber_id: i64,
    pub active_signed_id: i64,
    pub active_last_resort_id: i64,
    pub rotated_at: i64,
    pub synced_at: i64,
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoreCallbackError(pub String);

type SignalResult<T> = Result<T, SignalProtocolError>;

fn cb_err(method: &'static str) -> impl FnOnce(rusqlite::Error) -> SignalProtocolError {
    move |e| {
        SignalProtocolError::ApplicationCallbackError(
            method,
            Box::new(StoreCallbackError(e.to_string())),
        )
    }
}

pub fn map_signal_error(err: SignalProtocolError) -> ObscuraError {
    match err {
        SignalProtocolError::ApplicationCallbackError(_, inner) => {
            ObscuraError::storage(inner.to_string())
        }
        SignalProtocolError::InvalidArgument(reason) => ObscuraError::invalid_arg(reason),
        other => ObscuraError::protocol(other.to_string()),
    }
}

pub fn address_for(device_uuid: &str) -> ProtocolAddress {
    ProtocolAddress::new(
        device_uuid.to_owned(),
        libsignal_protocol::DeviceId::new(1).expect("device_id 1 is valid"),
    )
}

fn address_key(address: &ProtocolAddress) -> String {
    let dev: u32 = address.device_id().into();
    format!("{}.{dev}", address.name())
}

#[derive(Clone)]
pub struct SignalStore<'a> {
    pub conn: &'a Connection,
    effects: Rc<RefCell<Vec<PostCommitEffect>>>,
}

impl<'a> SignalStore<'a> {
    pub fn new(conn: &'a Connection, effects: Rc<RefCell<Vec<PostCommitEffect>>>) -> Self {
        Self { conn, effects }
    }

    pub fn has_identity(conn: &Connection) -> Result<bool, ObscuraError> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM signal_local_identity WHERE id = 1)",
            [],
            |r| r.get(0),
        )
        .map_err(ObscuraError::from)
    }

    pub fn get_local_identity(
        conn: &Connection,
    ) -> Result<Option<(IdentityKeyPair, u32)>, ObscuraError> {
        let row: Option<(Vec<u8>, i64)> = conn
            .query_row(
                "SELECT key_pair, registration_id FROM signal_local_identity WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((kp, reg)) => {
                let pair = IdentityKeyPair::try_from(&kp[..]).map_err(map_signal_error)?;
                Ok(Some((pair, reg as u32)))
            }
            None => Ok(None),
        }
    }

    pub fn install_identity(
        conn: &Connection,
        identity: &IdentityKeyPair,
        registration_id: u32,
    ) -> Result<(), ObscuraError> {
        conn.execute(
            "INSERT OR REPLACE INTO signal_local_identity (id, key_pair, registration_id) VALUES (1, ?1, ?2)",
            params![&identity.serialize()[..], registration_id as i64],
        )?;
        Ok(())
    }

    pub fn store_pre_key(
        conn: &Connection,
        id: u32,
        record: &PreKeyRecord,
    ) -> Result<(), ObscuraError> {
        let bytes = record.serialize().map_err(map_signal_error)?;
        conn.execute(
            "INSERT OR REPLACE INTO signal_prekeys (id, record, stale_at) VALUES (?1, ?2, 0)",
            params![id as i64, bytes],
        )?;
        Ok(())
    }

    pub fn store_signed_pre_key(
        conn: &Connection,
        id: u32,
        record: &SignedPreKeyRecord,
    ) -> Result<(), ObscuraError> {
        let bytes = record.serialize().map_err(map_signal_error)?;
        conn.execute(
            "INSERT OR REPLACE INTO signal_signed_prekeys (id, record) VALUES (?1, ?2)",
            params![id as i64, bytes],
        )?;
        Ok(())
    }

    pub fn store_kyber_pre_key(
        conn: &Connection,
        id: u32,
        record: &KyberPreKeyRecord,
        last_resort: bool,
    ) -> Result<(), ObscuraError> {
        let bytes = record.serialize().map_err(map_signal_error)?;
        conn.execute(
            "INSERT OR REPLACE INTO signal_kyber_prekeys (id, record, last_resort, stale_at) VALUES (?1, ?2, ?3, 0)",
            params![id as i64, bytes, i64::from(last_resort)],
        )?;
        Ok(())
    }

    pub fn pre_key_state(conn: &Connection) -> Result<Option<PreKeyState>, ObscuraError> {
        conn.query_row(
            "SELECT next_signed_id, next_one_time_id, next_kyber_id, active_signed_id,
                    active_last_resort_id, rotated_at, synced_at
             FROM signal_prekey_state WHERE id = 1",
            [],
            |r| {
                Ok(PreKeyState {
                    next_signed_id: r.get(0)?,
                    next_one_time_id: r.get(1)?,
                    next_kyber_id: r.get(2)?,
                    active_signed_id: r.get(3)?,
                    active_last_resort_id: r.get(4)?,
                    rotated_at: r.get(5)?,
                    synced_at: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(ObscuraError::from)
    }

    pub fn save_pre_key_state(conn: &Connection, state: &PreKeyState) -> Result<(), ObscuraError> {
        conn.execute(
            "INSERT OR REPLACE INTO signal_prekey_state (
                id, next_signed_id, next_one_time_id, next_kyber_id,
                active_signed_id, active_last_resort_id, rotated_at, synced_at
            ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                state.next_signed_id,
                state.next_one_time_id,
                state.next_kyber_id,
                state.active_signed_id,
                state.active_last_resort_id,
                state.rotated_at,
                state.synced_at,
            ],
        )?;
        Ok(())
    }

    pub fn mark_one_time_ec_pre_keys_stale(
        conn: &Connection,
        now_ms: i64,
    ) -> Result<(), ObscuraError> {
        conn.execute(
            "UPDATE signal_prekeys SET stale_at = ?1 WHERE stale_at = 0",
            params![now_ms],
        )?;
        Ok(())
    }

    pub fn mark_one_time_kyber_pre_keys_stale(
        conn: &Connection,
        now_ms: i64,
    ) -> Result<(), ObscuraError> {
        conn.execute(
            "UPDATE signal_kyber_prekeys SET stale_at = ?1 WHERE stale_at = 0 AND last_resort = 0",
            params![now_ms],
        )?;
        Ok(())
    }

    pub fn clean_pre_keys(conn: &Connection, now_ms: i64) -> Result<(), ObscuraError> {
        let Some(state) = Self::pre_key_state(conn)? else {
            return Ok(());
        };
        let signed = Self::load_all_signed_pre_keys(conn)?;
        for id in archived_ids(
            &signed,
            state.active_signed_id,
            now_ms,
            |r| u32::from(r.id().unwrap_or(0.into())) as i64,
            |r| {
                r.timestamp()
                    .map(|t| t.epoch_millis() as i64)
                    .unwrap_or(now_ms)
            },
        ) {
            conn.execute(
                "DELETE FROM signal_signed_prekeys WHERE id = ?1",
                params![id],
            )?;
        }

        let last_resort = Self::load_last_resort_kyber_pre_keys(conn)?;
        for id in archived_ids(
            &last_resort,
            state.active_last_resort_id,
            now_ms,
            |r| u32::from(r.id().unwrap_or(0.into())) as i64,
            |r| {
                r.timestamp()
                    .map(|t| t.epoch_millis() as i64)
                    .unwrap_or(now_ms)
            },
        ) {
            conn.execute(
                "DELETE FROM signal_kyber_prekeys WHERE id = ?1",
                params![id],
            )?;
            conn.execute(
                "DELETE FROM signal_last_resort_key_uses WHERE kyber_id = ?1",
                params![id],
            )?;
        }

        let cutoff = now_ms - STALE_ONE_TIME_AGE_MS;
        conn.execute(
            "DELETE FROM signal_prekeys
             WHERE stale_at > 0 AND stale_at < ?1 AND id NOT IN (
                 SELECT id FROM signal_prekeys
                 ORDER BY CASE stale_at WHEN 0 THEN 1 ELSE 0 END DESC, stale_at DESC, id DESC
                 LIMIT ?2
             )",
            params![cutoff, MIN_ONE_TIME_KEPT],
        )?;
        conn.execute(
            "DELETE FROM signal_kyber_prekeys
             WHERE last_resort = 0 AND stale_at > 0 AND stale_at < ?1 AND id NOT IN (
                 SELECT id FROM signal_kyber_prekeys WHERE last_resort = 0
                 ORDER BY CASE stale_at WHEN 0 THEN 1 ELSE 0 END DESC, stale_at DESC, id DESC
                 LIMIT ?2
             )",
            params![cutoff, MIN_ONE_TIME_KEPT],
        )?;
        Ok(())
    }

    pub fn load_all_signed_pre_keys(
        conn: &Connection,
    ) -> Result<Vec<SignedPreKeyRecord>, ObscuraError> {
        let mut stmt = conn.prepare("SELECT record FROM signal_signed_prekeys")?;
        let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row?;
            out.push(SignedPreKeyRecord::deserialize(&raw).map_err(map_signal_error)?);
        }
        Ok(out)
    }

    pub fn load_last_resort_kyber_pre_keys(
        conn: &Connection,
    ) -> Result<Vec<KyberPreKeyRecord>, ObscuraError> {
        let mut stmt =
            conn.prepare("SELECT record FROM signal_kyber_prekeys WHERE last_resort = 1")?;
        let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row?;
            out.push(KyberPreKeyRecord::deserialize(&raw).map_err(map_signal_error)?);
        }
        Ok(out)
    }

    pub fn contains_session(conn: &Connection, device_id: &str) -> Result<bool, ObscuraError> {
        let key = format!("{device_id}.1");
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM signal_sessions WHERE address = ?1)",
            params![key],
            |r| r.get(0),
        )
        .map_err(ObscuraError::from)
    }
}

fn archived_ids<T>(
    records: &[T],
    active_id: i64,
    now_ms: i64,
    id_fn: impl Fn(&T) -> i64,
    created_at_fn: impl Fn(&T) -> i64,
) -> Vec<i64> {
    let mut candidates: Vec<(i64, i64)> = records
        .iter()
        .map(|r| (id_fn(r), created_at_fn(r)))
        .filter(|(id, created_at)| *id != active_id && now_ms - *created_at > ARCHIVE_AGE_MS)
        .collect();
    candidates.sort_by_key(|a| std::cmp::Reverse(a.1));
    candidates.into_iter().skip(1).map(|(id, _)| id).collect()
}

#[async_trait(?Send)]
impl IdentityKeyStore for SignalStore<'_> {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        let kp: Vec<u8> = self
            .conn
            .query_row(
                "SELECT key_pair FROM signal_local_identity WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .map_err(cb_err("get_identity_key_pair"))?;
        IdentityKeyPair::try_from(&kp[..])
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        let reg: i64 = self
            .conn
            .query_row(
                "SELECT registration_id FROM signal_local_identity WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .map_err(cb_err("get_local_registration_id"))?;
        Ok(reg as u32)
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let user_id: String = self
            .conn
            .query_row(
                "SELECT user_id FROM devices WHERE device_id = ?1",
                params![address.name()],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("save_identity"))?
            .ok_or_else(|| {
                SignalProtocolError::ApplicationCallbackError(
                    "save_identity",
                    Box::new(StoreCallbackError(format!(
                        "Device {} is not in the directory",
                        address.name()
                    ))),
                )
            })?;

        let existing: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT identity_key FROM signal_identities WHERE user_id = ?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("save_identity"))?;

        let new_bytes = identity.serialize();
        if let Some(ref existing_bytes) = existing
            && bool::from(existing_bytes.as_slice().ct_eq(&new_bytes[..]))
        {
            return Ok(IdentityChange::NewOrUnchanged);
        }

        self.conn
            .execute(
                "INSERT OR REPLACE INTO signal_identities (user_id, identity_key) VALUES (?1, ?2)",
                params![user_id, &new_bytes[..]],
            )
            .map_err(cb_err("save_identity"))?;

        if existing.is_some() {
            self.conn
                .execute(
                    "DELETE FROM signal_sessions WHERE address IN (
                         SELECT device_id || '.1' FROM devices WHERE user_id = ?1
                     )",
                    params![user_id],
                )
                .map_err(cb_err("save_identity"))?;
            self.conn
                .execute(
                    "DELETE FROM devices WHERE user_id = ?1 AND device_id != ?2",
                    params![user_id, address.name()],
                )
                .map_err(cb_err("save_identity"))?;
            self.effects
                .borrow_mut()
                .push(PostCommitEffect::IdentityChanged(user_id));
            Ok(IdentityChange::ReplacedExisting)
        } else {
            Ok(IdentityChange::NewOrUnchanged)
        }
    }

    async fn is_trusted_identity(
        &self,
        _address: &ProtocolAddress,
        _identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        Ok(true)
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        let key: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT si.identity_key
                 FROM devices d
                 JOIN signal_identities si ON si.user_id = d.user_id
                 WHERE d.device_id = ?1",
                params![address.name()],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("get_identity"))?;
        key.map(|k| IdentityKey::decode(&k)).transpose()
    }
}

#[async_trait(?Send)]
impl PreKeyStore for SignalStore<'_> {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT record FROM signal_prekeys WHERE id = ?1",
                params![u32::from(prekey_id) as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("get_pre_key"))?;
        let raw = raw.ok_or(SignalProtocolError::InvalidPreKeyId)?;
        PreKeyRecord::deserialize(&raw)
    }

    async fn save_pre_key(
        &mut self,
        prekey_id: PreKeyId,
        record: &PreKeyRecord,
    ) -> SignalResult<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO signal_prekeys (id, record, stale_at) VALUES (?1, ?2, 0)",
                params![u32::from(prekey_id) as i64, record.serialize()?],
            )
            .map_err(cb_err("save_pre_key"))?;
        Ok(())
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        self.conn
            .execute(
                "DELETE FROM signal_prekeys WHERE id = ?1",
                params![u32::from(prekey_id) as i64],
            )
            .map_err(cb_err("remove_pre_key"))?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for SignalStore<'_> {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT record FROM signal_signed_prekeys WHERE id = ?1",
                params![u32::from(id) as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("get_signed_pre_key"))?;
        let raw = raw.ok_or(SignalProtocolError::InvalidSignedPreKeyId)?;
        SignedPreKeyRecord::deserialize(&raw)
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO signal_signed_prekeys (id, record) VALUES (?1, ?2)",
                params![u32::from(id) as i64, record.serialize()?],
            )
            .map_err(cb_err("save_signed_pre_key"))?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl KyberPreKeyStore for SignalStore<'_> {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> SignalResult<KyberPreKeyRecord> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT record FROM signal_kyber_prekeys WHERE id = ?1",
                params![u32::from(id) as i64],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("get_kyber_pre_key"))?;
        let raw = raw.ok_or(SignalProtocolError::InvalidKyberPreKeyId)?;
        KyberPreKeyRecord::deserialize(&raw)
    }

    async fn save_kyber_pre_key(
        &mut self,
        id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO signal_kyber_prekeys (id, record, last_resort, stale_at) VALUES (?1, ?2, 0, 0)",
                params![u32::from(id) as i64, record.serialize()?],
            )
            .map_err(cb_err("save_kyber_pre_key"))?;
        Ok(())
    }

    async fn mark_kyber_pre_key_used(
        &mut self,
        kyber_id: KyberPreKeyId,
        signed_id: SignedPreKeyId,
        base_key: &PublicKey,
    ) -> SignalResult<()> {
        let id = u32::from(kyber_id) as i64;
        let last_resort: Option<i64> = self
            .conn
            .query_row(
                "SELECT last_resort FROM signal_kyber_prekeys WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("mark_kyber_pre_key_used"))?;
        if last_resort != Some(1) {
            self.conn
                .execute(
                    "DELETE FROM signal_kyber_prekeys WHERE id = ?1 AND last_resort = 0",
                    params![id],
                )
                .map_err(cb_err("mark_kyber_pre_key_used"))?;
            return Ok(());
        }
        let base = base_key.serialize();
        let inserted = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO signal_last_resort_key_uses (kyber_id, signed_id, base_key)
                 VALUES (?1, ?2, ?3)",
                params![id, u32::from(signed_id) as i64, &base[..]],
            )
            .map_err(cb_err("mark_kyber_pre_key_used"))?;
        if inserted == 0 {
            return Err(SignalProtocolError::InvalidMessage(
                CiphertextMessageType::PreKey,
                format!("Base key reused with last-resort Kyber prekey {id}"),
            ));
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl SessionStore for SignalStore<'_> {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        let raw: Option<Vec<u8>> = self
            .conn
            .query_row(
                "SELECT record FROM signal_sessions WHERE address = ?1",
                params![address_key(address)],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("load_session"))?;
        raw.map(|r| SessionRecord::deserialize(&r)).transpose()
    }

    async fn store_session(
        &mut self,
        address: &ProtocolAddress,
        record: &SessionRecord,
    ) -> SignalResult<()> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO signal_sessions (address, record) VALUES (?1, ?2)",
                params![address_key(address), record.serialize()?],
            )
            .map_err(cb_err("store_session"))?;
        Ok(())
    }
}
