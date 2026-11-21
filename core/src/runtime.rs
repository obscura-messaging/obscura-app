use std::future::Future;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::task::JoinHandle;

static RUNTIME_HANDLE: OnceLock<tokio::runtime::Handle> = OnceLock::new();

/// Captures `async_compat`'s global Tokio runtime handle once in a thread without a local runtime,
/// ensuring background tasks spawned from synchronous FFI methods (`open`, `disconnect`,
/// `WebSocketSink` callbacks) or tests run on the process-wide runtime without panicking.
pub fn runtime_handle() -> &'static tokio::runtime::Handle {
    RUNTIME_HANDLE.get_or_init(|| {
        std::thread::Builder::new()
            .name("obscura-core-rt-init".to_owned())
            .spawn(|| {
                futures::executor::block_on(uniffi::deps::async_compat::Compat::new(async {
                    tokio::runtime::Handle::current()
                }))
            })
            .expect("failed to spawn runtime init thread")
            .join()
            .expect("runtime init thread panicked")
    })
}

pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime_handle().spawn(future)
}

pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    runtime_handle().spawn_blocking(f)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
