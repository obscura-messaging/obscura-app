use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use rand::Rng;
use uuid::Uuid;

use crate::error::ObscuraError;

pub const KEY_SIZE: usize = 32;
pub const NONCE_SIZE: usize = 12;
const EXTENSIONS: [&str; 3] = ["jpg", "mp4", "mov"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedAttachment {
    pub ciphertext: Vec<u8>,
    pub content_key: Vec<u8>,
    pub nonce: Vec<u8>,
}

pub fn random_nonce() -> Vec<u8> {
    let mut nonce = vec![0u8; NONCE_SIZE];
    rand::rng().fill(&mut nonce[..]);
    nonce
}

pub fn encrypt(plaintext: &[u8]) -> Result<EncryptedAttachment, ObscuraError> {
    let mut content_key = vec![0u8; KEY_SIZE];
    rand::rng().fill(&mut content_key[..]);
    let nonce = random_nonce();
    let ciphertext = encrypt_with_key(plaintext, &content_key, &nonce)?;
    Ok(EncryptedAttachment {
        ciphertext,
        content_key,
        nonce,
    })
}

pub fn encrypt_with_key(
    plaintext: &[u8],
    key: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, ObscuraError> {
    if key.len() != KEY_SIZE {
        return Err(ObscuraError::invalid_arg(format!(
            "Attachment key must be {KEY_SIZE} bytes, got {}",
            key.len()
        )));
    }
    if nonce.len() != NONCE_SIZE {
        return Err(ObscuraError::invalid_arg(format!(
            "Attachment nonce must be {NONCE_SIZE} bytes, got {}",
            nonce.len()
        )));
    }
    let key = Key::<Aes256Gcm>::try_from(key)
        .map_err(|e| ObscuraError::invalid_arg(format!("Invalid key: {e}")))?;
    let nonce = Nonce::try_from(nonce)
        .map_err(|e| ObscuraError::invalid_arg(format!("Invalid nonce: {e}")))?;
    let cipher = Aes256Gcm::new(&key);
    cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| ObscuraError::protocol(format!("Attachment encryption failed: {e}")))
}

pub fn decrypt(
    ciphertext: &[u8],
    content_key: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, ObscuraError> {
    if content_key.len() != KEY_SIZE || nonce.len() != NONCE_SIZE {
        return Err(ObscuraError::protocol(
            "Invalid attachment key or nonce length",
        ));
    }
    let key = Key::<Aes256Gcm>::try_from(content_key)
        .map_err(|_| ObscuraError::protocol("Invalid attachment key"))?;
    let nonce =
        Nonce::try_from(nonce).map_err(|_| ObscuraError::protocol("Invalid attachment nonce"))?;
    let cipher = Aes256Gcm::new(&key);
    cipher
        .decrypt(&nonce, ciphertext)
        .map_err(|_| ObscuraError::protocol("Attachment decryption failed"))
}

pub fn safe_stem(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn sniff_extension(data: &[u8]) -> &'static str {
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        if &data[8..12] == b"qt  " {
            "mov"
        } else {
            "mp4"
        }
    } else {
        "jpg"
    }
}

pub fn read_cached(cache_dir: &Path, id: &str) -> Option<PathBuf> {
    let safe = safe_stem(id);
    for ext in EXTENSIONS {
        let p = cache_dir.join(format!("{safe}.{ext}"));
        if let Ok(meta) = fs::metadata(&p)
            && meta.is_file()
            && meta.len() > 0
        {
            return Some(p);
        }
    }
    None
}

pub fn write_cached(cache_dir: &Path, id: &str, data: &[u8]) -> Result<PathBuf, ObscuraError> {
    fs::create_dir_all(cache_dir)
        .map_err(|e| ObscuraError::storage(format!("Failed to create cache dir: {e}")))?;
    let safe = safe_stem(id);
    let ext = sniff_extension(data);
    let dest = cache_dir.join(format!("{safe}.{ext}"));
    let tmp = cache_dir.join(format!("{safe}.{ext}.{}.tmp", Uuid::new_v4()));
    let write_res = fs::write(&tmp, data)
        .map_err(|e| ObscuraError::storage(format!("Failed to write cached attachment: {e}")));
    if let Err(e) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if fs::rename(&tmp, &dest).is_err() {
        fs::copy(&tmp, &dest).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            ObscuraError::storage(format!("Failed to move cached attachment into place: {e}"))
        })?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(dest)
}

pub fn purge_cached(cache_dir: &Path, id: &str) {
    let stem = safe_stem(id);
    for ext in EXTENSIONS {
        let _ = fs::remove_file(cache_dir.join(format!("{stem}.{ext}")));
        let _ = fs::remove_file(cache_dir.join(format!("{stem}.{ext}.tmp")));
    }
    if let Ok(entries) = fs::read_dir(cache_dir) {
        let prefix = format!("{stem}.");
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(name_str) = name.to_str()
                && name_str.starts_with(&prefix)
                && name_str.ends_with(".tmp")
            {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

pub fn purge_all_cached(cache_dir: &Path) {
    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
}
