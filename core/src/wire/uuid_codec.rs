use uuid::Uuid;

use crate::error::ObscuraError;

pub fn uuid_to_bytes(s: &str) -> Result<Vec<u8>, ObscuraError> {
    let parsed =
        Uuid::try_parse(s).map_err(|_| ObscuraError::invalid_arg(format!("Invalid UUID: {s}")))?;
    if parsed.hyphenated().to_string() != s.to_ascii_lowercase() {
        return Err(ObscuraError::invalid_arg(format!("Invalid UUID: {s}")));
    }
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
    Uuid::try_parse(s).is_ok_and(|u| u.hyphenated().to_string() == s.to_ascii_lowercase())
}
