use uuid::Uuid;

use crate::error::ObscuraError;

fn is_canonical_lowercase(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| !b.is_ascii_uppercase())
}

pub fn uuid_to_bytes(s: &str) -> Result<Vec<u8>, ObscuraError> {
    if !is_canonical_lowercase(s) {
        return Err(ObscuraError::invalid_arg(format!("Invalid UUID: {s}")));
    }
    let parsed =
        Uuid::try_parse(s).map_err(|_| ObscuraError::invalid_arg(format!("Invalid UUID: {s}")))?;
    Ok(parsed.as_bytes().to_vec())
}

pub fn uuid_string(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 16 {
        return None;
    }
    Uuid::from_slice(bytes)
        .ok()
        .map(|u| u.hyphenated().to_string())
}

pub fn is_uuid(s: &str) -> bool {
    is_canonical_lowercase(s) && Uuid::try_parse(s).is_ok()
}
