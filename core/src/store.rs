//! libsignal protocol stores backed by one SQLCipher database.
//!
//! `SqlStore` is a cheap, cloneable handle over a shared connection. libsignal's session
//! functions take several `&mut dyn *Store` arguments at once, so each call clones the
//! handle once per store argument; the caller serialises whole operations (see
//! `SpikeClient`) and wraps each one in a transaction.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use libsignal_protocol::{
    CiphertextMessageType, Direction, GenericSignedPreKey, IdentityChange, IdentityKey,
    IdentityKeyPair, IdentityKeyStore, KyberPreKeyId, KyberPreKeyRecord, KyberPreKeyStore,
    PreKeyId, PreKeyRecord, PreKeyStore, ProtocolAddress, PublicKey, SessionRecord, SessionStore,
    SignalProtocolError, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore,
};
use rusqlite::{Connection, OptionalExtension, params};

use crate::CoreError;

/// Error surfaced to libsignal from a store callback. It becomes
/// `SignalProtocolError::ApplicationCallbackError`, which `CoreError` maps back to `Storage`.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct StoreError(String);

type SignalResult<T> = Result<T, SignalProtocolError>;

fn cb_err(method: &'static str) -> impl FnOnce(rusqlite::Error) -> SignalProtocolError {
    move |e| {
        SignalProtocolError::ApplicationCallbackError(method, Box::new(StoreError(e.to_string())))
    }
}

fn storage(e: rusqlite::Error) -> CoreError {
    CoreError::Storage {
        message: e.to_string(),
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS local_identity (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    key_pair BLOB NOT NULL,
    registration_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
    name TEXT NOT NULL, device_id INTEGER NOT NULL, identity_key BLOB NOT NULL,
    PRIMARY KEY (name, device_id)
);
CREATE TABLE IF NOT EXISTS sessions (
    name TEXT NOT NULL, device_id INTEGER NOT NULL, record BLOB NOT NULL,
    PRIMARY KEY (name, device_id)
);
CREATE TABLE IF NOT EXISTS pre_keys (id INTEGER PRIMARY KEY, record BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS signed_pre_keys (id INTEGER PRIMARY KEY, record BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS kyber_pre_keys (id INTEGER PRIMARY KEY, record BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS kyber_base_keys_seen (
    kyber_pre_key_id INTEGER NOT NULL, signed_pre_key_id INTEGER NOT NULL, base_key BLOB NOT NULL,
    PRIMARY KEY (kyber_pre_key_id, signed_pre_key_id, base_key)
);
";

#[derive(Clone)]
pub struct SqlStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqlStore {
    /// Opens (creating if absent) the database at `path`, keyed with the raw 32-byte `key`.
    /// The raw key bypasses SQLCipher's PBKDF2: the host already holds a random key.
    pub fn open(path: impl AsRef<Path>, key: &[u8]) -> Result<Self, CoreError> {
        if key.len() != 32 {
            return Err(CoreError::InvalidArgument {
                message: format!("db_key must be 32 bytes, got {}", key.len()),
            });
        }
        let conn = Connection::open(path).map_err(storage)?;
        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
        // `PRAGMA key` cannot take bound parameters; the value is hex we produced ourselves.
        conn.execute_batch(&format!("PRAGMA key = \"x'{hex}'\";"))
            .map_err(storage)?;
        // A wrong key is only detected on first read of the database.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(storage)?;
        conn.execute_batch(SCHEMA).map_err(storage)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another call panicked mid-operation; its transaction
        // was never committed, so the connection itself is still consistent.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Runs `f` inside one SQLite transaction, committing on `Ok` and rolling back on `Err`,
    /// so a failed decrypt never persists half-advanced ratchet state.
    pub fn transaction<T>(&self, f: impl FnOnce() -> Result<T, CoreError>) -> Result<T, CoreError> {
        self.conn()
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(storage)?;
        match f() {
            Ok(v) => {
                self.conn().execute_batch("COMMIT").map_err(storage)?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn().execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // ---- Imports of raw serialized libsignal records (for interop tests) ----

    /// Stores `IdentityKeyPair::serialize()` bytes and the registration id, replacing any
    /// existing local identity.
    pub fn import_identity(
        &self,
        identity_key_pair: &[u8],
        registration_id: u32,
    ) -> Result<(), CoreError> {
        IdentityKeyPair::try_from(identity_key_pair).map_err(protocol)?;
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO local_identity (id, key_pair, registration_id) VALUES (0, ?1, ?2)",
                params![identity_key_pair, registration_id],
            )
            .map_err(storage)?;
        Ok(())
    }

    /// Stores `SignedPreKeyRecord::serialize()` bytes under the record's own id.
    pub fn import_signed_pre_key(&self, record: &[u8]) -> Result<(), CoreError> {
        let id: u32 = SignedPreKeyRecord::deserialize(record)
            .and_then(|r| r.id())
            .map_err(protocol)?
            .into();
        self.put("signed_pre_keys", id, record)
    }

    /// Stores `KyberPreKeyRecord::serialize()` bytes under the record's own id.
    pub fn import_kyber_pre_key(&self, record: &[u8]) -> Result<(), CoreError> {
        let id: u32 = KyberPreKeyRecord::deserialize(record)
            .and_then(|r| r.id())
            .map_err(protocol)?
            .into();
        self.put("kyber_pre_keys", id, record)
    }

    /// Stores `PreKeyRecord::serialize()` bytes under the record's own id.
    pub fn import_pre_key(&self, record: &[u8]) -> Result<(), CoreError> {
        let id: u32 = PreKeyRecord::deserialize(record)
            .and_then(|r| r.id())
            .map_err(protocol)?
            .into();
        self.put("pre_keys", id, record)
    }

    // ---- Helpers used by SpikeClient ----

    pub(crate) fn local_identity(&self) -> Result<Option<(IdentityKeyPair, u32)>, CoreError> {
        let row: Option<(Vec<u8>, u32)> = self
            .conn()
            .query_row(
                "SELECT key_pair, registration_id FROM local_identity WHERE id = 0",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        row.map(|(kp, reg)| Ok((IdentityKeyPair::try_from(&kp[..]).map_err(protocol)?, reg)))
            .transpose()
    }

    pub(crate) fn get_raw(
        &self,
        table: &'static str,
        id: u32,
    ) -> Result<Option<Vec<u8>>, CoreError> {
        self.get(table, id).map_err(storage)
    }

    pub(crate) fn put(&self, table: &'static str, id: u32, record: &[u8]) -> Result<(), CoreError> {
        self.conn()
            .execute(
                &format!("INSERT OR REPLACE INTO {table} (id, record) VALUES (?1, ?2)"),
                params![id, record],
            )
            .map_err(storage)?;
        Ok(())
    }

    fn get(&self, table: &'static str, id: u32) -> rusqlite::Result<Option<Vec<u8>>> {
        self.conn()
            .query_row(
                &format!("SELECT record FROM {table} WHERE id = ?1"),
                params![id],
                |r| r.get(0),
            )
            .optional()
    }
}

fn protocol(e: SignalProtocolError) -> CoreError {
    CoreError::Protocol {
        message: e.to_string(),
    }
}

fn device(address: &ProtocolAddress) -> u32 {
    address.device_id().into()
}

#[async_trait(?Send)]
impl IdentityKeyStore for SqlStore {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        let kp: Vec<u8> = self
            .conn()
            .query_row(
                "SELECT key_pair FROM local_identity WHERE id = 0",
                [],
                |r| r.get(0),
            )
            .map_err(cb_err("get_identity_key_pair"))?;
        IdentityKeyPair::try_from(&kp[..])
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        self.conn()
            .query_row(
                "SELECT registration_id FROM local_identity WHERE id = 0",
                [],
                |r| r.get(0),
            )
            .map_err(cb_err("get_local_registration_id"))
    }

    async fn save_identity(
        &mut self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let existing = self.get_identity(address).await?;
        if existing.as_ref() == Some(identity) {
            return Ok(IdentityChange::NewOrUnchanged);
        }
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO identities (name, device_id, identity_key) VALUES (?1, ?2, ?3)",
                params![address.name(), device(address), &identity.serialize()[..]],
            )
            .map_err(cb_err("save_identity"))?;
        Ok(IdentityChange::from_changed(existing.is_some()))
    }

    async fn is_trusted_identity(
        &self,
        address: &ProtocolAddress,
        identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        // Trust on first use; a changed key is untrusted until the host re-verifies it.
        Ok(match self.get_identity(address).await? {
            None => true,
            Some(known) => &known == identity,
        })
    }

    async fn get_identity(&self, address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        let key: Option<Vec<u8>> = self
            .conn()
            .query_row(
                "SELECT identity_key FROM identities WHERE name = ?1 AND device_id = ?2",
                params![address.name(), device(address)],
                |r| r.get(0),
            )
            .optional()
            .map_err(cb_err("get_identity"))?;
        key.map(|k| IdentityKey::decode(&k)).transpose()
    }
}

#[async_trait(?Send)]
impl PreKeyStore for SqlStore {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        let raw = self
            .get("pre_keys", prekey_id.into())
            .map_err(cb_err("get_pre_key"))?
            .ok_or(SignalProtocolError::InvalidPreKeyId)?;
        PreKeyRecord::deserialize(&raw)
    }

    async fn save_pre_key(
        &mut self,
        prekey_id: PreKeyId,
        record: &PreKeyRecord,
    ) -> SignalResult<()> {
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO pre_keys (id, record) VALUES (?1, ?2)",
                params![u32::from(prekey_id), record.serialize()?],
            )
            .map_err(cb_err("save_pre_key"))?;
        Ok(())
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        self.conn()
            .execute(
                "DELETE FROM pre_keys WHERE id = ?1",
                params![u32::from(prekey_id)],
            )
            .map_err(cb_err("remove_pre_key"))?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for SqlStore {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        let raw = self
            .get("signed_pre_keys", id.into())
            .map_err(cb_err("get_signed_pre_key"))?
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)?;
        SignedPreKeyRecord::deserialize(&raw)
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO signed_pre_keys (id, record) VALUES (?1, ?2)",
                params![u32::from(id), record.serialize()?],
            )
            .map_err(cb_err("save_signed_pre_key"))?;
        Ok(())
    }
}

#[async_trait(?Send)]
impl KyberPreKeyStore for SqlStore {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> SignalResult<KyberPreKeyRecord> {
        let raw = self
            .get("kyber_pre_keys", id.into())
            .map_err(cb_err("get_kyber_pre_key"))?
            .ok_or(SignalProtocolError::InvalidKyberPreKeyId)?;
        KyberPreKeyRecord::deserialize(&raw)
    }

    async fn save_kyber_pre_key(
        &mut self,
        id: KyberPreKeyId,
        record: &KyberPreKeyRecord,
    ) -> SignalResult<()> {
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO kyber_pre_keys (id, record) VALUES (?1, ?2)",
                params![u32::from(id), record.serialize()?],
            )
            .map_err(cb_err("save_kyber_pre_key"))?;
        Ok(())
    }

    /// The spike only has last-resort Kyber prekeys, which are kept after use; like
    /// libsignal's in-memory store, reject a reused (kyber, signed, base key) triple.
    async fn mark_kyber_pre_key_used(
        &mut self,
        kyber_id: KyberPreKeyId,
        signed_id: SignedPreKeyId,
        base_key: &PublicKey,
    ) -> SignalResult<()> {
        let inserted = self
            .conn()
            .execute(
                "INSERT OR IGNORE INTO kyber_base_keys_seen (kyber_pre_key_id, signed_pre_key_id, base_key)
                 VALUES (?1, ?2, ?3)",
                params![u32::from(kyber_id), u32::from(signed_id), &base_key.serialize()[..]],
            )
            .map_err(cb_err("mark_kyber_pre_key_used"))?;
        if inserted == 0 {
            return Err(SignalProtocolError::InvalidMessage(
                CiphertextMessageType::PreKey,
                "reused base key".to_owned(),
            ));
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl SessionStore for SqlStore {
    async fn load_session(&self, address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        let raw: Option<Vec<u8>> = self
            .conn()
            .query_row(
                "SELECT record FROM sessions WHERE name = ?1 AND device_id = ?2",
                params![address.name(), device(address)],
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
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO sessions (name, device_id, record) VALUES (?1, ?2, ?3)",
                params![address.name(), device(address), record.serialize()?],
            )
            .map_err(cb_err("store_session"))?;
        Ok(())
    }
}
