use std::cell::RefCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;

use rusqlite::{Connection, ErrorCode};
use tokio::sync::{mpsc, oneshot};

use crate::error::ObscuraError;
use crate::types::EntryModel;

pub mod content_store;
pub mod device_store;
pub mod friend_store;
pub mod history_sync;
pub mod signal_store;

pub const CORE_SCHEMA_VERSION: i64 = 100;

static OPEN_DB_PATHS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn open_paths() -> &'static Mutex<HashSet<PathBuf>> {
    OPEN_DB_PATHS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn normalize_db_path(path_str: &str) -> PathBuf {
    let p = Path::new(path_str);
    if let Some(parent) = p.parent()
        && !parent.as_os_str().is_empty()
        && let Ok(canon_parent) = std::fs::canonicalize(parent)
        && let Some(file_name) = p.file_name()
    {
        return canon_parent.join(file_name);
    }
    p.to_path_buf()
}

struct OpenPathGuard(Option<PathBuf>);

impl OpenPathGuard {
    fn register(database_path: Option<&str>) -> Result<Self, ObscuraError> {
        let Some(path_str) = database_path else {
            return Ok(Self(None));
        };
        if path_str.trim().is_empty() {
            return Err(ObscuraError::invalid_arg("databasePath must not be blank"));
        }
        let path = Path::new(path_str);
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| {
                ObscuraError::storage(format!("Failed to create database directory: {e}"))
            })?;
        }
        let normalized = normalize_db_path(path_str);
        let mut set = open_paths().lock().unwrap_or_else(|p| p.into_inner());
        if !set.insert(normalized.clone()) {
            return Err(ObscuraError::invalid_arg(format!(
                "Database path is already open: {path_str}"
            )));
        }
        Ok(Self(Some(normalized)))
    }
}

impl Drop for OpenPathGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let mut set = open_paths().lock().unwrap_or_else(|p| p.into_inner());
            set.remove(&path);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostCommitEffect {
    IdentityChanged(String),
    FriendsChanged,
    EntryInboxed(EntryModel),
}

pub type EffectDispatcher = Arc<dyn Fn(PostCommitEffect) + Send + Sync>;

pub struct DbContext<'a> {
    pub conn: &'a Connection,
    effects: Rc<RefCell<Vec<PostCommitEffect>>>,
}

impl<'a> DbContext<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self {
            conn,
            effects: Rc::new(RefCell::new(Vec::new())),
        }
    }

    pub fn push_effect(&self, effect: PostCommitEffect) {
        self.effects.borrow_mut().push(effect);
    }

    pub fn signal_store(&self) -> signal_store::SignalStore<'a> {
        signal_store::SignalStore::new(self.conn, Rc::clone(&self.effects))
    }

    pub fn into_effects(self) -> Vec<PostCommitEffect> {
        self.effects.take()
    }
}

type DbTask = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

enum ActorMsg {
    Task(DbTask),
    Shutdown,
}

#[derive(Clone)]
pub struct DbHandle {
    tx: mpsc::UnboundedSender<ActorMsg>,
    join_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    dispatcher: Arc<Mutex<Option<EffectDispatcher>>>,
}

impl DbHandle {
    pub fn open(
        database_path: Option<&str>,
        database_key: &[u8],
        dispatcher: Option<EffectDispatcher>,
    ) -> Result<Self, ObscuraError> {
        if database_path.is_some() && database_key.len() != 32 {
            return Err(ObscuraError::invalid_arg(format!(
                "db_key must be 32 bytes, got {}",
                database_key.len()
            )));
        }
        let guard = OpenPathGuard::register(database_path)?;
        let path_owned = database_path.map(str::to_owned);
        let key_owned = database_key.to_vec();
        let (tx, mut rx) = mpsc::unbounded_channel::<ActorMsg>();
        let (init_tx, init_rx) = std::sync::mpsc::sync_channel::<Result<(), ObscuraError>>(1);

        let join_handle = std::thread::Builder::new()
            .name("obscura-core-db".to_owned())
            .spawn(move || {
                let _guard = guard;
                let mut conn = match init_connection(path_owned.as_deref(), &key_owned) {
                    Ok(c) => {
                        let _ = init_tx.send(Ok(()));
                        c
                    }
                    Err(e) => {
                        let _ = init_tx.send(Err(e));
                        return;
                    }
                };
                while let Some(msg) = rx.blocking_recv() {
                    match msg {
                        ActorMsg::Task(task) => task(&mut conn),
                        ActorMsg::Shutdown => break,
                    }
                }
            })
            .map_err(|e| ObscuraError::storage(format!("Failed to spawn DB thread: {e}")))?;

        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                tx,
                join_handle: Arc::new(Mutex::new(Some(join_handle))),
                dispatcher: Arc::new(Mutex::new(dispatcher)),
            }),
            Ok(Err(e)) => {
                let _ = join_handle.join();
                Err(e)
            }
            Err(e) => {
                let _ = join_handle.join();
                Err(ObscuraError::storage(format!(
                    "DB thread initialization failed: {e}"
                )))
            }
        }
    }

    pub fn set_dispatcher(&self, dispatcher: EffectDispatcher) {
        *self.dispatcher.lock().unwrap_or_else(|p| p.into_inner()) = Some(dispatcher);
    }

    pub async fn read<T, F>(&self, f: F) -> Result<T, ObscuraError>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T, ObscuraError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMsg::Task(Box::new(move |conn| {
                let _ = reply_tx.send(f(conn));
            })))
            .map_err(|_| ObscuraError::storage("Database actor is shut down"))?;
        reply_rx
            .await
            .map_err(|_| ObscuraError::storage("Database actor dropped read response"))?
    }

    pub async fn raw<T, F>(&self, f: F) -> Result<T, ObscuraError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, ObscuraError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMsg::Task(Box::new(move |conn| {
                let _ = reply_tx.send(f(conn));
            })))
            .map_err(|_| ObscuraError::storage("Database actor is shut down"))?;
        reply_rx
            .await
            .map_err(|_| ObscuraError::storage("Database actor dropped raw response"))?
    }

    pub async fn write_tx<T, F>(&self, f: F) -> Result<T, ObscuraError>
    where
        T: Send + 'static,
        F: FnOnce(&mut DbContext<'_>) -> Result<T, ObscuraError> + Send + 'static,
    {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.tx
            .send(ActorMsg::Task(Box::new(move |conn| {
                let res = run_transaction(conn, f);
                let _ = reply_tx.send(res);
            })))
            .map_err(|_| ObscuraError::storage("Database actor is shut down"))?;
        let (val, effects) = reply_rx
            .await
            .map_err(|_| ObscuraError::storage("Database actor dropped write response"))??;
        self.dispatch_effects(effects);
        Ok(val)
    }

    pub fn dispatch_effects(&self, effects: Vec<PostCommitEffect>) {
        if effects.is_empty() {
            return;
        }
        let disp = self
            .dispatcher
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        if let Some(dispatcher) = disp {
            for effect in effects {
                dispatcher(effect);
            }
        }
    }

    pub async fn truncate_wal(&self) -> Result<(), ObscuraError> {
        self.raw(|conn| truncate_wal_on_conn(conn)).await
    }

    pub async fn wipe_all(&self) -> Result<(), ObscuraError> {
        self.write_tx(|ctx| {
            ctx.conn.execute_batch("PRAGMA secure_delete = ON;")?;
            let existed_friends: i64 =
                ctx.conn
                    .query_row("SELECT count(*) FROM friends", [], |r| r.get(0))?;
            ctx.conn.execute_batch(
                "DELETE FROM friends;
                 DELETE FROM friend_list_version;
                 DELETE FROM devices;
                 DELETE FROM device_identity;
                 DELETE FROM signal_local_identity;
                 DELETE FROM signal_identities;
                 DELETE FROM signal_prekeys;
                 DELETE FROM signal_signed_prekeys;
                 DELETE FROM signal_kyber_prekeys;
                 DELETE FROM signal_last_resort_key_uses;
                 DELETE FROM signal_prekey_state;
                 DELETE FROM signal_sessions;
                 DELETE FROM processed_envelopes;
                 DELETE FROM pending_friend_replies;
                 DELETE FROM conversation_entries;
                 DELETE FROM story_entries;
                 DELETE FROM profile_entries;
                 DELETE FROM erased_entries;
                 DELETE FROM pending_media_purges;",
            )?;
            if existed_friends > 0 {
                ctx.push_effect(PostCommitEffect::FriendsChanged);
            }
            Ok(())
        })
        .await?;
        self.truncate_wal().await
    }

    pub async fn shutdown(&self) {
        let _ = self.tx.send(ActorMsg::Shutdown);
        let handle = self
            .join_handle
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(h) = handle {
            let _ = crate::runtime::spawn_blocking(move || {
                let _ = h.join();
            })
            .await;
        }
    }
}

fn run_transaction<T, F>(
    conn: &mut Connection,
    f: F,
) -> Result<(T, Vec<PostCommitEffect>), ObscuraError>
where
    F: FnOnce(&mut DbContext<'_>) -> Result<T, ObscuraError>,
{
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(ObscuraError::from)?;
    let mut ctx = DbContext::new(conn);
    match f(&mut ctx) {
        Ok(val) => {
            let effects = ctx.into_effects();
            if let Err(e) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(ObscuraError::from(e));
            }
            Ok((val, effects))
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

pub fn truncate_wal_on_conn(conn: &Connection) -> Result<(), ObscuraError> {
    let busy: i64 = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(ObscuraError::from)?;
    if busy != 0 {
        return Err(ObscuraError::storage(
            "WAL truncation could not complete; checkpoint is busy",
        ));
    }
    Ok(())
}

fn map_open_err(e: rusqlite::Error) -> ObscuraError {
    if matches!(
        e.sqlite_error_code(),
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    ) || e.to_string().contains("file is not a database")
        || e.to_string().contains("malformed")
    {
        ObscuraError::DatabaseUndecryptable {
            reason: e.to_string(),
        }
    } else {
        ObscuraError::StorageFailed {
            reason: e.to_string(),
        }
    }
}

fn init_connection(path: Option<&str>, key: &[u8]) -> Result<Connection, ObscuraError> {
    let conn = match path {
        Some(p) => {
            let conn = Connection::open(p).map_err(map_open_err)?;
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            conn.execute_batch(&format!(
                "PRAGMA key = \"x'{hex}'\";
                 PRAGMA kdf_iter = 1;
                 PRAGMA cipher_page_size = 4096;"
            ))
            .map_err(map_open_err)?;

            let user_version: i64 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(map_open_err)?;

            if user_version == 0 {
                let table_count: i64 = conn
                    .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
                    .map_err(map_open_err)?;
                if table_count > 0 {
                    return Err(ObscuraError::DatabaseUndecryptable {
                        reason: "Legacy database schema (user_version = 0) requires clean reset"
                            .to_owned(),
                    });
                }
            } else if user_version != CORE_SCHEMA_VERSION {
                return Err(ObscuraError::DatabaseUndecryptable {
                    reason: format!("Unsupported database schema version: {user_version}"),
                });
            }

            conn.execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = FULL;
                 PRAGMA secure_delete = ON;
                 PRAGMA foreign_keys = ON;
                 PRAGMA user_version = {CORE_SCHEMA_VERSION};"
            ))
            .map_err(map_open_err)?;
            conn
        }
        None => {
            let conn = Connection::open_in_memory().map_err(ObscuraError::from)?;
            conn.execute_batch(&format!(
                "PRAGMA secure_delete = ON;
                 PRAGMA foreign_keys = ON;
                 PRAGMA user_version = {CORE_SCHEMA_VERSION};"
            ))
            .map_err(ObscuraError::from)?;
            conn
        }
    };

    conn.execute_batch(SCHEMA).map_err(ObscuraError::from)?;
    Ok(conn)
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS friends (
    user_id TEXT NOT NULL PRIMARY KEY,
    username TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_list_version (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_identity (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL,
    primary_device_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS devices_user_id ON devices(user_id);

CREATE TABLE IF NOT EXISTS signal_local_identity (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    key_pair BLOB NOT NULL,
    registration_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_identities (
    user_id TEXT NOT NULL PRIMARY KEY,
    identity_key BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_prekeys (
    id INTEGER NOT NULL PRIMARY KEY,
    record BLOB NOT NULL,
    stale_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signal_signed_prekeys (
    id INTEGER NOT NULL PRIMARY KEY,
    record BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_kyber_prekeys (
    id INTEGER NOT NULL PRIMARY KEY,
    record BLOB NOT NULL,
    last_resort INTEGER NOT NULL,
    stale_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signal_last_resort_key_uses (
    kyber_id INTEGER NOT NULL,
    signed_id INTEGER NOT NULL,
    base_key BLOB NOT NULL,
    PRIMARY KEY (kyber_id, signed_id, base_key)
);

CREATE TABLE IF NOT EXISTS signal_prekey_state (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    next_signed_id INTEGER NOT NULL,
    next_one_time_id INTEGER NOT NULL,
    next_kyber_id INTEGER NOT NULL,
    active_signed_id INTEGER NOT NULL,
    active_last_resort_id INTEGER NOT NULL,
    rotated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_sessions (
    address TEXT NOT NULL PRIMARY KEY,
    record BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_envelopes (
    envelope_id TEXT NOT NULL PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS pending_friend_replies (
    envelope_id TEXT NOT NULL PRIMARY KEY,
    peer_user_id TEXT NOT NULL,
    action TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_entries (
    id TEXT NOT NULL PRIMARY KEY,
    peer_user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    author_user_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    viewed_at INTEGER,
    expires_at INTEGER NOT NULL,
    content TEXT NOT NULL,
    media_ref TEXT,
    content_key BLOB,
    nonce BLOB,
    media_type TEXT,
    caption TEXT,
    caption_meta TEXT,
    display_duration INTEGER NOT NULL,
    undelivered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS story_entries (
    id TEXT NOT NULL PRIMARY KEY,
    author_user_id TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    content TEXT NOT NULL,
    media_ref TEXT,
    content_key BLOB,
    nonce BLOB,
    media_type TEXT,
    caption_meta TEXT,
    undelivered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_entries (
    user_id TEXT NOT NULL PRIMARY KEY,
    author_device_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL,
    undelivered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS erased_entries (
    id TEXT NOT NULL PRIMARY KEY,
    erased_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_media_purges (
    media_ref TEXT NOT NULL PRIMARY KEY
);
";
