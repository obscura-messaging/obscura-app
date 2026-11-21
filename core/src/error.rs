#[derive(uniffi::Error, thiserror::Error, Debug, Clone, PartialEq, Eq)]
pub enum ObscuraError {
    #[error("Not authenticated")]
    NotAuthenticated,
    #[error("{reason}")]
    InvalidArgument { reason: String },
    #[error("Invalid friend code")]
    InvalidFriendCode,
    #[error("{reason}")]
    ConnectionFailed { reason: String },
    #[error("{reason}")]
    ProtocolViolation { reason: String },
    #[error("{reason}")]
    StorageFailed { reason: String },
    #[error("{reason}")]
    DatabaseUndecryptable { reason: String },
    #[error("{reason}")]
    SendFailed { reason: String },
    #[error("Only the primary device can do this")]
    NotPrimary,
    #[error("{reason}")]
    LinkFailed { reason: String },
    #[error("HTTP {status}")]
    Http { status: u16, body: String },
}

impl ObscuraError {
    pub fn code(&self) -> &'static str {
        match self {
            ObscuraError::NotAuthenticated => "NOT_AUTHENTICATED",
            ObscuraError::InvalidArgument { .. } => "INVALID_ARGUMENT",
            ObscuraError::InvalidFriendCode => "INVALID_FRIEND_CODE",
            ObscuraError::ConnectionFailed { .. } => "CONNECTION_FAILED",
            ObscuraError::ProtocolViolation { .. } => "PROTOCOL_VIOLATION",
            ObscuraError::StorageFailed { .. } | ObscuraError::DatabaseUndecryptable { .. } => {
                "STORAGE_ERROR"
            }
            ObscuraError::SendFailed { .. } => "SEND_FAILED",
            ObscuraError::NotPrimary => "NOT_PRIMARY",
            ObscuraError::LinkFailed { .. } => "LINK_FAILED",
            ObscuraError::Http { .. } => "HTTP_ERROR",
        }
    }

    pub fn invalid_arg(reason: impl Into<String>) -> Self {
        ObscuraError::InvalidArgument {
            reason: reason.into(),
        }
    }

    pub fn protocol(reason: impl Into<String>) -> Self {
        ObscuraError::ProtocolViolation {
            reason: reason.into(),
        }
    }

    pub fn storage(reason: impl Into<String>) -> Self {
        ObscuraError::StorageFailed {
            reason: reason.into(),
        }
    }

    pub fn connection(reason: impl Into<String>) -> Self {
        ObscuraError::ConnectionFailed {
            reason: reason.into(),
        }
    }

    pub fn link_failed(reason: impl Into<String>) -> Self {
        ObscuraError::LinkFailed {
            reason: reason.into(),
        }
    }

    pub fn send_failed(reason: impl Into<String>) -> Self {
        ObscuraError::SendFailed {
            reason: reason.into(),
        }
    }
}

impl From<uniffi::UnexpectedUniFFICallbackError> for ObscuraError {
    fn from(e: uniffi::UnexpectedUniFFICallbackError) -> Self {
        ObscuraError::StorageFailed { reason: e.reason }
    }
}

impl From<rusqlite::Error> for ObscuraError {
    fn from(e: rusqlite::Error) -> Self {
        ObscuraError::StorageFailed {
            reason: e.to_string(),
        }
    }
}

#[uniffi::export]
pub fn error_code(err: &ObscuraError) -> String {
    err.code().to_owned()
}

#[uniffi::export]
pub fn error_message(err: &ObscuraError) -> String {
    err.to_string()
}
