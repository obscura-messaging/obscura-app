//! Obscura Rust Core (`obscura-core`): full client implementation exported via UniFFI.

// Without SQLCipher, `PRAGMA key` is silently ignored and the database is plaintext.
#[cfg(not(any(feature = "sqlcipher-openssl", feature = "sqlcipher-commoncrypto")))]
compile_error!("enable one SQLCipher crypto feature: sqlcipher-openssl or sqlcipher-commoncrypto");
#[cfg(all(feature = "sqlcipher-openssl", feature = "sqlcipher-commoncrypto"))]
compile_error!("sqlcipher-openssl and sqlcipher-commoncrypto are mutually exclusive");

pub mod proto {
    pub mod server {
        include!(concat!(env!("OUT_DIR"), "/obscura.v1.rs"));
    }
    pub mod client {
        include!(concat!(env!("OUT_DIR"), "/obscura.client.v1.rs"));
    }
}

pub mod auth;
pub mod client;
pub mod crypto;
pub mod error;
pub mod messaging;
pub mod network;
pub mod runtime;
pub mod store;
pub mod types;
pub mod wire;

pub use client::ObscuraClient;
pub use crypto::link::link_code_device_name;
pub use error::{ObscuraError, error_code, error_message};
pub use network::transport::{
    ClientEventListener, HttpRequest, HttpResponse, ObscuraLogger, SessionStorage, Transport,
    WebSocketHandle, WebSocketSink,
};
pub use types::{
    AuthState, CaptureResult, ConnectionState, ConversationItem, ConversationKind, DeviceInfo,
    EntryModel, Friend, FriendStatus, LinkRequest, LoginScenario, MediaAttachment, MediaType,
    ObscuraClientConfig, ProfileItem, StoryItem, SubmissionResult, SubmissionStatus, TypingState,
};

uniffi::setup_scaffolding!("obscura_core");
