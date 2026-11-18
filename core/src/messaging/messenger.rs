use std::collections::{HashMap, HashSet};
use std::time::SystemTime;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures::executor::block_on;
use libsignal_protocol::{
    CiphertextMessage, IdentityKey, PreKeyBundle, PreKeySignalMessage, PublicKey, SignalMessage,
    SignalProtocolError, kem, message_decrypt, message_encrypt, process_prekey_bundle,
};
use prost::Message as _;
use serde_json::Value;

use crate::error::ObscuraError;
use crate::network::api::APIClient;
use crate::proto::client::{ClientMessage, EncryptedMessage, encrypted_message};
use crate::proto::server::{SendMessageRequest, SendMessageResponse, send_message_request};
use crate::store::signal_store::{SignalStore, address_for, map_signal_error};
use crate::store::{DbContext, DbHandle, device_store};
use crate::types::{SubmissionResult, SubmissionStatus};
use crate::wire::uuid_codec::{is_uuid, uuid_string, uuid_to_bytes};

#[derive(Debug, Clone)]
pub struct PeerBundle {
    pub device_id: String,
    pub registration_id: u32,
    pub identity_key: IdentityKey,
    pub signed_pre_key_id: u32,
    pub signed_pre_key: PublicKey,
    pub signed_pre_key_signature: Vec<u8>,
    pub kyber_pre_key_id: u32,
    pub kyber_pre_key: kem::PublicKey,
    pub kyber_pre_key_signature: Vec<u8>,
    pub one_time_pre_key: Option<(u32, PublicKey)>,
}

impl PeerBundle {
    pub fn to_libsignal_bundle(&self) -> Result<PreKeyBundle, ObscuraError> {
        let pre_key = self
            .one_time_pre_key
            .as_ref()
            .map(|(id, pk)| ((*id).into(), *pk));
        PreKeyBundle::new(
            self.registration_id,
            libsignal_protocol::DeviceId::new(1).expect("device_id 1 is valid"),
            pre_key,
            self.signed_pre_key_id.into(),
            self.signed_pre_key,
            self.signed_pre_key_signature.clone(),
            self.kyber_pre_key_id.into(),
            self.kyber_pre_key.clone(),
            self.kyber_pre_key_signature.clone(),
            self.identity_key,
        )
        .map_err(map_signal_error)
    }
}

pub fn parse_peer_bundles(values: &[Value]) -> Result<Vec<PeerBundle>, ObscuraError> {
    let mut out = Vec::with_capacity(values.len());
    let mut seen = HashSet::with_capacity(values.len());
    for v in values {
        let b = parse_peer_bundle(v)?;
        if !seen.insert(b.device_id.clone()) {
            return Err(ObscuraError::protocol("Duplicate device in bundles"));
        }
        out.push(b);
    }
    Ok(out)
}

pub fn parse_peer_bundle(v: &Value) -> Result<PeerBundle, ObscuraError> {
    let malformed = |msg: &str| ObscuraError::protocol(format!("Malformed bundle: {msg}"));
    let invalid_key = |msg: &str| ObscuraError::protocol(format!("Invalid key in bundle: {msg}"));

    let device_id = v
        .get("deviceId")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("missing deviceId"))?
        .to_owned();
    if !is_uuid(&device_id) {
        return Err(ObscuraError::protocol("Invalid device id in bundle"));
    }

    let registration_id = v
        .get("registrationId")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| malformed("missing registrationId"))?;

    let id_key_b64 = v
        .get("identityKey")
        .and_then(Value::as_str)
        .ok_or_else(|| malformed("missing identityKey"))?;
    let id_key_bytes = STANDARD
        .decode(id_key_b64)
        .map_err(|_| invalid_key("identityKey base64"))?;
    let identity_key =
        IdentityKey::decode(&id_key_bytes).map_err(|e| invalid_key(&e.to_string()))?;

    let spk = v
        .get("signedPreKey")
        .and_then(Value::as_object)
        .ok_or_else(|| malformed("missing signedPreKey"))?;
    let signed_pre_key_id = spk
        .get("keyId")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| malformed("missing signedPreKey.keyId"))?;
    let spk_pub_bytes = STANDARD
        .decode(
            spk.get("publicKey")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("missing signedPreKey.publicKey"))?,
        )
        .map_err(|_| invalid_key("signedPreKey.publicKey base64"))?;
    let signed_pre_key =
        PublicKey::deserialize(&spk_pub_bytes).map_err(|e| invalid_key(&e.to_string()))?;
    let signed_pre_key_signature = STANDARD
        .decode(
            spk.get("signature")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("missing signedPreKey.signature"))?,
        )
        .map_err(|_| invalid_key("signedPreKey.signature base64"))?;

    let kyber = v
        .get("kyberPreKey")
        .and_then(Value::as_object)
        .ok_or_else(|| malformed("missing kyberPreKey"))?;
    let kyber_pre_key_id = kyber
        .get("keyId")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| malformed("missing kyberPreKey.keyId"))?;
    let kyber_pub_bytes = STANDARD
        .decode(
            kyber
                .get("publicKey")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("missing kyberPreKey.publicKey"))?,
        )
        .map_err(|_| invalid_key("kyberPreKey.publicKey base64"))?;
    let kyber_pre_key =
        kem::PublicKey::deserialize(&kyber_pub_bytes).map_err(|e| invalid_key(&e.to_string()))?;
    let kyber_pre_key_signature = STANDARD
        .decode(
            kyber
                .get("signature")
                .and_then(Value::as_str)
                .ok_or_else(|| malformed("missing kyberPreKey.signature"))?,
        )
        .map_err(|_| invalid_key("kyberPreKey.signature base64"))?;

    let one_time_pre_key = match v.get("oneTimePreKey") {
        None | Some(Value::Null) => None,
        Some(Value::Object(otp)) => {
            let otp_id = otp
                .get("keyId")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| malformed("missing oneTimePreKey.keyId"))?;
            let otp_pub_bytes = STANDARD
                .decode(
                    otp.get("publicKey")
                        .and_then(Value::as_str)
                        .ok_or_else(|| malformed("missing oneTimePreKey.publicKey"))?,
                )
                .map_err(|_| invalid_key("oneTimePreKey.publicKey base64"))?;
            let otp_pub =
                PublicKey::deserialize(&otp_pub_bytes).map_err(|e| invalid_key(&e.to_string()))?;
            Some((otp_id, otp_pub))
        }
        Some(_) => return Err(malformed("oneTimePreKey is not an object")),
    };

    Ok(PeerBundle {
        device_id,
        registration_id,
        identity_key,
        signed_pre_key_id,
        signed_pre_key,
        signed_pre_key_signature,
        kyber_pre_key_id,
        kyber_pre_key,
        kyber_pre_key_signature,
        one_time_pre_key,
    })
}

pub fn require_consistent(bundles: &[PeerBundle]) -> Result<(), ObscuraError> {
    let Some(first) = bundles.first() else {
        return Ok(());
    };
    let identity = first.identity_key;
    for peer in bundles {
        if peer.identity_key != identity {
            return Err(ObscuraError::protocol(
                "Bundles carry different identity keys",
            ));
        }
        let spk_ok = identity.public_key().verify_signature(
            &peer.signed_pre_key.serialize(),
            &peer.signed_pre_key_signature,
        );
        if !spk_ok {
            return Err(ObscuraError::protocol(format!(
                "Signed prekey of device {} does not verify",
                peer.device_id
            )));
        }
        let kyber_ok = identity.public_key().verify_signature(
            &peer.kyber_pre_key.serialize(),
            &peer.kyber_pre_key_signature,
        );
        if !kyber_ok {
            return Err(ObscuraError::protocol(format!(
                "Kyber prekey of device {} does not verify",
                peer.device_id
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct UserSubmission {
    pub user_id: String,
    pub submission: send_message_request::Submission,
}

#[derive(Debug, Clone)]
pub struct Submitted {
    pub result: SubmissionResult,
    pub invalid_device: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SubmitOutcome {
    pub submitted: Vec<Submitted>,
    pub mismatches: HashMap<String, Vec<String>>,
}

pub fn decode_submission_results(
    user_ids: &[String],
    submissions: &[UserSubmission],
    response: &SendMessageResponse,
) -> Result<SubmitOutcome, ObscuraError> {
    let mut targeted_devices = HashSet::new();
    for s in submissions {
        let dev_id = uuid_string(&s.submission.device_id)
            .ok_or_else(|| ObscuraError::invalid_arg("Submission has invalid device ID"))?;
        targeted_devices.insert(dev_id);
    }

    let mut invalid_devices = HashSet::new();
    for bytes in &response.invalid_device_ids {
        let Some(id) = uuid_string(bytes) else {
            return Err(ObscuraError::protocol(
                "Response contains unknown or duplicate invalid device IDs",
            ));
        };
        if !targeted_devices.contains(&id) || !invalid_devices.insert(id) {
            return Err(ObscuraError::protocol(
                "Response contains unknown or duplicate invalid device IDs",
            ));
        }
    }

    let addressed: HashSet<&str> = user_ids.iter().map(String::as_str).collect();
    let mut mismatches: HashMap<String, Vec<String>> = HashMap::new();
    for m in &response.device_mismatches {
        let Some(user) = uuid_string(&m.user_id) else {
            return Err(ObscuraError::protocol(
                "Response contains an inconsistent device mismatch",
            ));
        };
        if !addressed.contains(user.as_str()) || mismatches.contains_key(&user) {
            return Err(ObscuraError::protocol(
                "Response contains an inconsistent device mismatch",
            ));
        }
        let mut missing = Vec::with_capacity(m.missing_device_ids.len());
        for dev_bytes in &m.missing_device_ids {
            let dev = uuid_string(dev_bytes)
                .ok_or_else(|| ObscuraError::protocol("Response contains an invalid device ID"))?;
            missing.push(dev);
        }
        mismatches.insert(user, missing);
    }

    let mut submitted = Vec::with_capacity(submissions.len());
    for sub in submissions {
        let device_id = uuid_string(&sub.submission.device_id)
            .ok_or_else(|| ObscuraError::invalid_arg("Submission has invalid device ID"))?;
        let is_invalid = invalid_devices.contains(&device_id);
        let missing = mismatches.get(&sub.user_id);
        let error = if is_invalid {
            Some("Device not found".to_owned())
        } else {
            missing.map(|m| format!("Devices not covered: {m:?}"))
        };
        submitted.push(Submitted {
            result: SubmissionResult {
                user_id: sub.user_id.clone(),
                device_id: Some(device_id),
                status: if error.is_none() {
                    SubmissionStatus::Accepted
                } else {
                    SubmissionStatus::Rejected
                },
                error,
            },
            invalid_device: is_invalid,
        });
    }

    Ok(SubmitOutcome {
        submitted,
        mismatches,
    })
}

pub enum DecryptCommitError {
    DuplicatedMessage,
    DecryptFailed(String),
    DatabaseError(&'static str, String),
}

#[derive(Clone)]
pub struct Messenger {
    db: DbHandle,
    api: APIClient,
    local_device_id: std::sync::Arc<dyn Fn() -> Option<String> + Send + Sync>,
}

impl Messenger {
    pub fn new(
        db: DbHandle,
        api: APIClient,
        local_device_id: std::sync::Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        Self {
            db,
            api,
            local_device_id,
        }
    }

    pub async fn has_session(&self, device_id: &str) -> Result<bool, ObscuraError> {
        let dev = device_id.to_owned();
        self.db
            .read(move |conn| SignalStore::contains_session(conn, &dev))
            .await
    }

    pub async fn establish_session_with_device(
        &self,
        user_id: &str,
        peer: PeerBundle,
    ) -> Result<(), ObscuraError> {
        let local_dev =
            (self.local_device_id)().ok_or_else(|| ObscuraError::storage("No local device"))?;
        let uid = user_id.to_owned();
        let bundle = peer.to_libsignal_bundle()?;
        let peer_dev = peer.device_id;
        self.db
            .write_tx(move |ctx| {
                device_store::add(ctx.conn, &uid, &peer_dev)?;
                if !SignalStore::contains_session(ctx.conn, &peer_dev)? {
                    let remote_addr = address_for(&peer_dev);
                    let local_addr = address_for(&local_dev);
                    let mut sessions = ctx.signal_store();
                    let mut identities = ctx.signal_store();
                    block_on(process_prekey_bundle(
                        &remote_addr,
                        &local_addr,
                        &mut sessions,
                        &mut identities,
                        &bundle,
                        SystemTime::now(),
                        &mut rand::rng(),
                    ))
                    .map_err(map_signal_error)?;
                }
                Ok(())
            })
            .await
    }

    pub async fn prepare_submission(
        &self,
        device_id: &str,
        message: &ClientMessage,
    ) -> Result<send_message_request::Submission, ObscuraError> {
        let local_dev =
            (self.local_device_id)().ok_or_else(|| ObscuraError::storage("No local device"))?;
        let dev = device_id.to_owned();
        let dev_bytes = uuid_to_bytes(device_id)?;
        let plaintext = message.encode_to_vec();

        self.db
            .write_tx(move |ctx| {
                if !SignalStore::contains_session(ctx.conn, &dev)? {
                    return Err(ObscuraError::invalid_arg(format!(
                        "No session with device {dev}"
                    )));
                }
                let remote_addr = address_for(&dev);
                let local_addr = address_for(&local_dev);
                let mut sessions = ctx.signal_store();
                let mut identities = ctx.signal_store();
                let ciphertext = block_on(message_encrypt(
                    &plaintext,
                    &remote_addr,
                    &local_addr,
                    &mut sessions,
                    &mut identities,
                    SystemTime::now(),
                    &mut rand::rng(),
                ))
                .map_err(map_signal_error)?;

                let (msg_type, content) = match ciphertext {
                    CiphertextMessage::PreKeySignalMessage(m) => (
                        encrypted_message::Type::PrekeyMessage as i32,
                        m.serialized().to_vec(),
                    ),
                    CiphertextMessage::SignalMessage(m) => (
                        encrypted_message::Type::EncryptedMessage as i32,
                        m.serialized().to_vec(),
                    ),
                    other => {
                        return Err(ObscuraError::protocol(format!(
                            "Unexpected ciphertext message type: {:?}",
                            other.message_type()
                        )));
                    }
                };
                let encrypted = EncryptedMessage {
                    r#type: msg_type,
                    content,
                };
                Ok(send_message_request::Submission {
                    device_id: dev_bytes,
                    message: encrypted.encode_to_vec(),
                })
            })
            .await
    }

    pub async fn submit(
        &self,
        user_ids: &[String],
        submissions: &[UserSubmission],
    ) -> SubmitOutcome {
        let res: Result<SubmitOutcome, ObscuraError> = async {
            let mut by_user: HashMap<&str, Vec<send_message_request::Submission>> = HashMap::new();
            for sub in submissions {
                by_user
                    .entry(sub.user_id.as_str())
                    .or_default()
                    .push(sub.submission.clone());
            }
            let mut seen_users = HashSet::new();
            let mut recipients = Vec::new();
            for uid in user_ids {
                if seen_users.insert(uid.as_str()) {
                    recipients.push(send_message_request::Recipient {
                        user_id: uuid_to_bytes(uid)?,
                        submissions: by_user.remove(uid.as_str()).unwrap_or_default(),
                    });
                }
            }
            let req = SendMessageRequest { recipients };
            let resp_bytes = self.api.send_message(req.encode_to_vec()).await?;
            let resp = SendMessageResponse::decode(&resp_bytes[..])
                .map_err(|e| ObscuraError::protocol(format!("Invalid SendMessageResponse: {e}")))?;
            decode_submission_results(user_ids, submissions, &resp)
        }
        .await;

        match res {
            Ok(outcome) => outcome,
            Err(e) => {
                let definitive = matches!(
                    e,
                    ObscuraError::Http {
                        status: 400 | 413,
                        ..
                    }
                );
                let err_str = e.to_string();
                let submitted = submissions
                    .iter()
                    .map(|sub| {
                        let dev_id = uuid_string(&sub.submission.device_id);
                        Submitted {
                            result: SubmissionResult {
                                user_id: sub.user_id.clone(),
                                device_id: dev_id,
                                status: if definitive {
                                    SubmissionStatus::Rejected
                                } else {
                                    SubmissionStatus::Unknown
                                },
                                error: Some(err_str.clone()),
                            },
                            invalid_device: false,
                        }
                    })
                    .collect();
                SubmitOutcome {
                    submitted,
                    mismatches: HashMap::new(),
                }
            }
        }
    }

    pub async fn decrypt_and_commit<T, F>(
        &self,
        sender_user_id: &str,
        sender_device_id: &str,
        encrypted: EncryptedMessage,
        persist: F,
    ) -> Result<T, DecryptCommitError>
    where
        T: Send + 'static,
        F: FnOnce(&mut DbContext<'_>, Vec<u8>) -> Result<T, ObscuraError> + Send + 'static,
    {
        let Some(local_dev) = (self.local_device_id)() else {
            return Err(DecryptCommitError::DatabaseError(
                "decrypt",
                "No local device".to_owned(),
            ));
        };
        let sender_uid = sender_user_id.to_owned();
        let sender_dev = sender_device_id.to_owned();

        let (tx_res, effects) = self
            .db
            .raw(move |conn| {
                conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| {
                    ObscuraError::storage(format!("Failed to begin receive transaction: {e}"))
                })?;
                let mut ctx = DbContext::new(conn);
                let outcome: Result<T, DecryptCommitError> = (|| {
                    if let Err(e) = device_store::add(ctx.conn, &sender_uid, &sender_dev) {
                        return Err(match e {
                            ObscuraError::ProtocolViolation { reason } => {
                                DecryptCommitError::DecryptFailed(reason)
                            }
                            other => {
                                DecryptCommitError::DatabaseError("directory", other.to_string())
                            }
                        });
                    }

                    let msg_type = encrypted_message::Type::try_from(encrypted.r#type)
                        .unwrap_or(encrypted_message::Type::Unspecified);
                    let ciphertext = match msg_type {
                        encrypted_message::Type::PrekeyMessage => {
                            let pk = PreKeySignalMessage::try_from(&encrypted.content[..])
                                .map_err(|e| DecryptCommitError::DecryptFailed(e.to_string()))?;
                            CiphertextMessage::PreKeySignalMessage(pk)
                        }
                        encrypted_message::Type::EncryptedMessage => {
                            let sm = SignalMessage::try_from(&encrypted.content[..])
                                .map_err(|e| DecryptCommitError::DecryptFailed(e.to_string()))?;
                            CiphertextMessage::SignalMessage(sm)
                        }
                        encrypted_message::Type::Unspecified => {
                            return Err(DecryptCommitError::DecryptFailed(
                                "Unspecified encrypted message type".to_owned(),
                            ));
                        }
                    };

                    let remote_addr = address_for(&sender_dev);
                    let local_addr = address_for(&local_dev);
                    let mut sessions = ctx.signal_store();
                    let mut identities = ctx.signal_store();
                    let mut pre_keys = ctx.signal_store();
                    let signed_pre_keys = ctx.signal_store();
                    let mut kyber_pre_keys = ctx.signal_store();

                    let plaintext = block_on(message_decrypt(
                        &ciphertext,
                        &remote_addr,
                        &local_addr,
                        &mut sessions,
                        &mut identities,
                        &mut pre_keys,
                        &signed_pre_keys,
                        &mut kyber_pre_keys,
                        &mut rand::rng(),
                    ))
                    .map_err(|e| match e {
                        SignalProtocolError::DuplicatedMessage(_, _) => {
                            DecryptCommitError::DuplicatedMessage
                        }
                        SignalProtocolError::ApplicationCallbackError(_, inner) => {
                            DecryptCommitError::DatabaseError("decrypt", inner.to_string())
                        }
                        other => DecryptCommitError::DecryptFailed(other.to_string()),
                    })?;

                    persist(&mut ctx, plaintext)
                        .map_err(|e| DecryptCommitError::DatabaseError("persist", e.to_string()))
                })();

                match outcome {
                    Ok(val) => {
                        let effects = ctx.into_effects();
                        if let Err(e) = conn.execute_batch("COMMIT") {
                            let _ = conn.execute_batch("ROLLBACK");
                            return Ok((
                                Err(DecryptCommitError::DatabaseError("persist", e.to_string())),
                                Vec::new(),
                            ));
                        }
                        Ok((Ok(val), effects))
                    }
                    Err(err) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        Ok((Err(err), Vec::new()))
                    }
                }
            })
            .await
            .map_err(|e| DecryptCommitError::DatabaseError("directory", e.to_string()))?;

        self.db.dispatch_effects(effects);
        tx_res
    }
}
