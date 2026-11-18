use base64::{
    Engine as _, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use serde::{Deserialize, Serialize};

use crate::error::ObscuraError;

const INDIF_BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFriendCode {
    pub user_id: String,
    pub username: String,
}

#[derive(Serialize, Deserialize)]
struct RawFriendCode {
    #[serde(default)]
    u: String,
    #[serde(default)]
    n: String,
}

pub fn encode(user_id: &str, username: &str) -> String {
    let raw = RawFriendCode {
        u: user_id.to_owned(),
        n: username.to_owned(),
    };
    let json = serde_json::to_vec(&raw).expect("serializing friend code cannot fail");
    base64::engine::general_purpose::STANDARD.encode(json)
}

pub fn decode(code: &str) -> Result<DecodedFriendCode, ObscuraError> {
    let cleaned: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{00AD}')
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    if cleaned.is_empty() {
        return Err(ObscuraError::InvalidFriendCode);
    }
    let bytes = INDIF_BASE64
        .decode(cleaned)
        .map_err(|_| ObscuraError::InvalidFriendCode)?;
    let raw: RawFriendCode =
        serde_json::from_slice(&bytes).map_err(|_| ObscuraError::InvalidFriendCode)?;
    if raw.u.trim().is_empty() || raw.n.trim().is_empty() {
        return Err(ObscuraError::InvalidFriendCode);
    }
    Ok(DecodedFriendCode {
        user_id: raw.u,
        username: raw.n,
    })
}
