use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hkdf::Hkdf;
use libsignal_protocol::{KeyPair, PrivateKey, PublicKey};
use prost::Message as _;
use sha2::Sha256;

use crate::crypto::attachment;
use crate::error::ObscuraError;
use crate::proto::client::{LinkCode, LinkEnvelope};

const INFO: &[u8] = b"Obscura link v1";
const KEY_SIZE: usize = 32;

pub fn derive_key(shared_secret: &[u8]) -> [u8; KEY_SIZE] {
    let hk = Hkdf::<Sha256>::new(Some(&[]), shared_secret);
    let mut okm = [0u8; KEY_SIZE];
    hk.expand(INFO, &mut okm)
        .expect("32-byte HKDF output is valid");
    okm
}

pub fn seal(plaintext: &[u8], peer: &PublicKey) -> Result<LinkEnvelope, ObscuraError> {
    let ephemeral = KeyPair::generate(&mut rand::rng());
    let nonce = attachment::random_nonce();
    seal_with(plaintext, peer, &ephemeral, &nonce)
}

pub fn seal_with(
    plaintext: &[u8],
    peer: &PublicKey,
    ephemeral: &KeyPair,
    nonce: &[u8],
) -> Result<LinkEnvelope, ObscuraError> {
    let shared_secret = ephemeral
        .private_key
        .calculate_agreement(peer)
        .map_err(|e| ObscuraError::link_failed(format!("Key agreement failed: {e}")))?;
    let key = derive_key(&shared_secret);
    let ciphertext = attachment::encrypt_with_key(plaintext, &key, nonce)
        .map_err(|e| ObscuraError::link_failed(e.to_string()))?;
    Ok(LinkEnvelope {
        ephemeral_public_key: ephemeral.public_key.serialize().into_vec(),
        nonce: nonce.to_vec(),
        ciphertext,
    })
}

pub fn open(envelope_bytes: &[u8], own: &PrivateKey) -> Result<Vec<u8>, ObscuraError> {
    let parsed = LinkEnvelope::decode(envelope_bytes)
        .map_err(|_| ObscuraError::link_failed("Link envelope is malformed"))?;
    if parsed.nonce.len() != attachment::NONCE_SIZE {
        return Err(ObscuraError::link_failed(
            "Link envelope nonce has invalid length",
        ));
    }
    let peer = PublicKey::deserialize(&parsed.ephemeral_public_key)
        .map_err(|_| ObscuraError::link_failed("Link envelope key is invalid"))?;
    let shared_secret = own
        .calculate_agreement(&peer)
        .map_err(|_| ObscuraError::link_failed("Link envelope key is invalid"))?;
    let key = derive_key(&shared_secret);
    attachment::decrypt(&parsed.ciphertext, &key, &parsed.nonce)
        .map_err(|_| ObscuraError::link_failed("Link envelope does not decrypt"))
}

pub fn encode_code(code: &LinkCode) -> String {
    URL_SAFE_NO_PAD.encode(code.encode_to_vec())
}

pub fn decode_code(text: &str) -> Result<LinkCode, ObscuraError> {
    let invalid = || ObscuraError::invalid_arg("Invalid link code");
    if text.contains('=') {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(text).map_err(|_| invalid())?;
    let code = LinkCode::decode(&bytes[..]).map_err(|_| invalid())?;
    if code.session_id.is_empty() || public_key(&code).is_err() {
        return Err(invalid());
    }
    Ok(code)
}

pub fn public_key(code: &LinkCode) -> Result<PublicKey, ObscuraError> {
    PublicKey::deserialize(&code.ephemeral_public_key)
        .map_err(|_| ObscuraError::invalid_arg("Invalid link code"))
}

#[uniffi::export]
pub fn link_code_device_name(code: String) -> Result<String, ObscuraError> {
    Ok(decode_code(&code)?.device_name)
}
