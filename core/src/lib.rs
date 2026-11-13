//! Obscura core spike: libsignal sessions over an SQLCipher store, exported with UniFFI.

use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use futures::executor::block_on;
use libsignal_protocol::{
    CiphertextMessage, DeviceId, GenericSignedPreKey, IdentityKey, IdentityKeyPair, KeyPair,
    KyberPreKeyRecord, PreKeyBundle, PreKeyRecord, PreKeySignalMessage, ProtocolAddress,
    SignalMessage, SignalProtocolError, SignedPreKeyRecord, Timestamp, kem, message_decrypt,
    message_encrypt, process_prekey_bundle,
};
use rand::Rng;

pub mod store;
use store::SqlStore;

uniffi::setup_scaffolding!("obscura_core");

const SIGNED_PRE_KEY_ID: u32 = 1;
const KYBER_PRE_KEY_ID: u32 = 1;
const PRE_KEY_ID: u32 = 1;

#[derive(uniffi::Error, Debug, thiserror::Error)]
pub enum CoreError {
    #[error("storage: {message}")]
    Storage { message: String },
    #[error("protocol: {message}")]
    Protocol { message: String },
    #[error("invalid argument: {message}")]
    InvalidArgument { message: String },
}

impl From<SignalProtocolError> for CoreError {
    fn from(e: SignalProtocolError) -> Self {
        match e {
            SignalProtocolError::ApplicationCallbackError(..) => CoreError::Storage {
                message: e.to_string(),
            },
            SignalProtocolError::InvalidArgument(_) => CoreError::InvalidArgument {
                message: e.to_string(),
            },
            _ => CoreError::Protocol {
                message: e.to_string(),
            },
        }
    }
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct PreKeyBundleData {
    pub registration_id: u32,
    pub device_id: u32,
    pub identity_key: Vec<u8>,
    pub signed_pre_key_id: u32,
    pub signed_pre_key: Vec<u8>,
    pub signed_pre_key_signature: Vec<u8>,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key: Vec<u8>,
    pub kyber_pre_key_signature: Vec<u8>,
    pub pre_key_id: Option<u32>,
    pub pre_key: Option<Vec<u8>>,
}

#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CiphertextKind {
    PreKey,
    Whisper,
}

#[derive(uniffi::Record, Clone, Debug)]
pub struct Ciphertext {
    pub kind: CiphertextKind,
    pub bytes: Vec<u8>,
}

// ---- Logging ----

/// Callback across the FFI, to prove foreign trait objects work.
#[uniffi::export(with_foreign)]
pub trait CoreLogger: Send + Sync {
    fn log(&self, message: String);
}

static LOGGER: RwLock<Option<Arc<dyn CoreLogger>>> = RwLock::new(None);

#[uniffi::export]
pub fn set_logger(logger: Arc<dyn CoreLogger>) {
    *LOGGER.write().unwrap_or_else(|p| p.into_inner()) = Some(logger);
}

/// Never pass user identifiers, keys or plaintext here: hosts may forward logs off-device.
fn log(message: impl FnOnce() -> String) {
    let logger = LOGGER.read().unwrap_or_else(|p| p.into_inner()).clone();
    if let Some(logger) = logger {
        logger.log(message());
    }
}

// ---- Client ----

#[derive(uniffi::Object)]
pub struct SpikeClient {
    /// Held for the whole of each operation: libsignal's load-modify-store of a session is not
    /// safe to interleave, and SQLite transactions are per connection.
    store: Mutex<SqlStore>,
    address: ProtocolAddress,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidArgument {
        message: message.into(),
    }
}

fn device_id(id: u32) -> Result<DeviceId, CoreError> {
    DeviceId::try_from(id).map_err(|_| invalid(format!("invalid device id {id}")))
}

impl SpikeClient {
    fn with_store<T>(
        &self,
        f: impl FnOnce(&SqlStore) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        store.transaction(|| f(&store))
    }
}

#[uniffi::export]
impl SpikeClient {
    /// Opens (creating if absent) an SQLCipher database keyed with `db_key` (32 bytes from the
    /// host's Keystore/Keychain). Wrong key -> CoreError::Storage.
    #[uniffi::constructor]
    pub fn open(
        db_path: String,
        db_key: Vec<u8>,
        name: String,
        device_id: u32,
    ) -> Result<Arc<Self>, CoreError> {
        let address = ProtocolAddress::new(name, self::device_id(device_id)?);
        let store = SqlStore::open(&db_path, &db_key).inspect_err(|e| {
            log(|| format!("open failed: {e}"));
        })?;
        log(|| "opened store".to_owned());
        Ok(Arc::new(Self {
            store: Mutex::new(store),
            address,
        }))
    }

    /// Generates identity, signed prekey, Kyber prekey and one one-time prekey if absent;
    /// returns the public bundle.
    pub fn create_identity_and_bundle(&self) -> Result<PreKeyBundleData, CoreError> {
        self.with_store(|store| {
            let mut rng = rand::rng();
            let (identity, registration_id) = match store.local_identity()? {
                Some(found) => found,
                None => {
                    let identity = IdentityKeyPair::generate(&mut rng);
                    let registration_id = rng.random_range(1..=16380);
                    store.import_identity(&identity.serialize(), registration_id)?;
                    log(|| "generated identity".to_owned());
                    (identity, registration_id)
                }
            };

            let signed = match store.get_raw("signed_pre_keys", SIGNED_PRE_KEY_ID)? {
                Some(raw) => SignedPreKeyRecord::deserialize(&raw)?,
                None => {
                    let pair = KeyPair::generate(&mut rng);
                    let signature = identity
                        .private_key()
                        .calculate_signature(&pair.public_key.serialize(), &mut rng)
                        .map_err(SignalProtocolError::from)?;
                    let record = SignedPreKeyRecord::new(
                        SIGNED_PRE_KEY_ID.into(),
                        Timestamp::from_epoch_millis(now_millis()),
                        &pair,
                        &signature,
                    );
                    store.put("signed_pre_keys", SIGNED_PRE_KEY_ID, &record.serialize()?)?;
                    record
                }
            };

            let kyber = match store.get_raw("kyber_pre_keys", KYBER_PRE_KEY_ID)? {
                Some(raw) => KyberPreKeyRecord::deserialize(&raw)?,
                None => {
                    let record = KyberPreKeyRecord::generate(
                        kem::KeyType::Kyber1024,
                        KYBER_PRE_KEY_ID.into(),
                        identity.private_key(),
                    )?;
                    // Last-resort, so a bundle fetched twice still works; the kits also hand out
                    // one-time Kyber keys, which `SqlStore::import_kyber_pre_key` can hold.
                    store.put_kyber(KYBER_PRE_KEY_ID, &record.serialize()?, true)?;
                    record
                }
            };

            // Regenerated under the same id once a peer has consumed it: enough for a spike,
            // not for a real prekey rotation scheme.
            let pre_key = match store.get_raw("pre_keys", PRE_KEY_ID)? {
                Some(raw) => PreKeyRecord::deserialize(&raw)?,
                None => {
                    let record = PreKeyRecord::new(PRE_KEY_ID.into(), &KeyPair::generate(&mut rng));
                    store.put("pre_keys", PRE_KEY_ID, &record.serialize()?)?;
                    record
                }
            };

            Ok(PreKeyBundleData {
                registration_id,
                device_id: self.address.device_id().into(),
                identity_key: identity.identity_key().serialize().into_vec(),
                signed_pre_key_id: SIGNED_PRE_KEY_ID,
                signed_pre_key: signed.public_key()?.serialize().into_vec(),
                signed_pre_key_signature: signed.signature()?,
                kyber_pre_key_id: KYBER_PRE_KEY_ID,
                kyber_pre_key: kyber.public_key()?.serialize().into_vec(),
                kyber_pre_key_signature: kyber.signature()?,
                pre_key_id: Some(PRE_KEY_ID),
                pre_key: Some(pre_key.public_key()?.serialize().into_vec()),
            })
        })
    }

    pub fn process_bundle(
        &self,
        peer_name: String,
        peer_device: u32,
        bundle: PreKeyBundleData,
    ) -> Result<(), CoreError> {
        let peer = ProtocolAddress::new(peer_name, device_id(peer_device)?);
        let bundle = to_libsignal_bundle(bundle)?;
        self.with_store(|store| {
            let (mut sessions, mut identities) = (store.clone(), store.clone());
            block_on(process_prekey_bundle(
                &peer,
                &self.address,
                &mut sessions,
                &mut identities,
                &bundle,
                SystemTime::now(),
                &mut rand::rng(),
            ))?;
            log(|| "processed bundle".to_owned());
            Ok(())
        })
    }

    pub fn encrypt(
        &self,
        peer_name: String,
        peer_device: u32,
        plaintext: Vec<u8>,
    ) -> Result<Ciphertext, CoreError> {
        let peer = ProtocolAddress::new(peer_name, device_id(peer_device)?);
        self.with_store(|store| {
            let (mut sessions, mut identities) = (store.clone(), store.clone());
            let message = block_on(message_encrypt(
                &plaintext,
                &peer,
                &self.address,
                &mut sessions,
                &mut identities,
                SystemTime::now(),
                &mut rand::rng(),
            ))?;
            let out = match message {
                CiphertextMessage::PreKeySignalMessage(m) => Ciphertext {
                    kind: CiphertextKind::PreKey,
                    bytes: m.serialized().to_vec(),
                },
                CiphertextMessage::SignalMessage(m) => Ciphertext {
                    kind: CiphertextKind::Whisper,
                    bytes: m.serialized().to_vec(),
                },
                other => {
                    return Err(CoreError::Protocol {
                        message: format!("unexpected message type {:?}", other.message_type()),
                    });
                }
            };
            log(|| format!("encrypted {:?} ({} bytes)", out.kind, out.bytes.len()));
            Ok(out)
        })
    }

    pub fn decrypt(
        &self,
        peer_name: String,
        peer_device: u32,
        ciphertext: Ciphertext,
    ) -> Result<Vec<u8>, CoreError> {
        let peer = ProtocolAddress::new(peer_name, device_id(peer_device)?);
        let kind = ciphertext.kind;
        let message = match kind {
            CiphertextKind::PreKey => CiphertextMessage::PreKeySignalMessage(
                PreKeySignalMessage::try_from(&ciphertext.bytes[..])?,
            ),
            CiphertextKind::Whisper => {
                CiphertextMessage::SignalMessage(SignalMessage::try_from(&ciphertext.bytes[..])?)
            }
        };
        self.with_store(|store| {
            let mut sessions = store.clone();
            let mut identities = store.clone();
            let mut pre_keys = store.clone();
            let signed_pre_keys = store.clone();
            let mut kyber_pre_keys = store.clone();
            let plaintext = block_on(message_decrypt(
                &message,
                &peer,
                &self.address,
                &mut sessions,
                &mut identities,
                &mut pre_keys,
                &signed_pre_keys,
                &mut kyber_pre_keys,
                &mut rand::rng(),
            ))?;
            log(|| format!("decrypted {kind:?}"));
            Ok(plaintext)
        })
        .inspect_err(|e| log(|| format!("decrypt {kind:?} failed: {e}")))
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn to_libsignal_bundle(b: PreKeyBundleData) -> Result<PreKeyBundle, CoreError> {
    let pre_key = match (b.pre_key_id, b.pre_key) {
        (Some(id), Some(key)) => Some((
            id.into(),
            libsignal_protocol::PublicKey::deserialize(&key).map_err(SignalProtocolError::from)?,
        )),
        (None, None) => None,
        _ => {
            return Err(invalid(
                "pre_key_id and pre_key must both be set or both be absent",
            ));
        }
    };
    Ok(PreKeyBundle::new(
        b.registration_id,
        device_id(b.device_id)?,
        pre_key,
        b.signed_pre_key_id.into(),
        libsignal_protocol::PublicKey::deserialize(&b.signed_pre_key)
            .map_err(SignalProtocolError::from)?,
        b.signed_pre_key_signature,
        b.kyber_pre_key_id.into(),
        kem::PublicKey::deserialize(&b.kyber_pre_key)?,
        b.kyber_pre_key_signature,
        IdentityKey::decode(&b.identity_key)?,
    )?)
}

// Stretch experiment: an async export. Awaiting libsignal's `message_decrypt` directly in an
// async export does not compile: UniFFI's `rust_future_new` requires `Send`, and libsignal's
// store futures are `async_trait(?Send)` over `&mut dyn *Store` (plus `ThreadRng` is `!Send`).
// What works is running the synchronous call on its own thread and awaiting a oneshot, which
// is `Send`; the foreign caller gets a real suspend point without a blocked thread of its own.
#[uniffi::export]
impl SpikeClient {
    pub async fn decrypt_async(
        self: Arc<Self>,
        peer_name: String,
        peer_device: u32,
        ciphertext: Ciphertext,
    ) -> Result<Vec<u8>, CoreError> {
        let (tx, rx) = futures::channel::oneshot::channel();
        std::thread::Builder::new()
            .name("obscura-core-decrypt".to_owned())
            .spawn(move || {
                let _ = tx.send(self.decrypt(peer_name, peer_device, ciphertext));
            })
            .map_err(|e| CoreError::Storage {
                message: format!("spawn failed: {e}"),
            })?;
        rx.await.map_err(|_| CoreError::Protocol {
            message: "decrypt worker dropped its result".to_owned(),
        })?
    }
}
