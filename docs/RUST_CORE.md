# Why One Rust Core (`core/`)

Obscura shares its UI, state, and domain projections in TypeScript (`src/`), while native hosts (`android/`, `ios/`) own OS lifecycle, permissions, Keystore/Keychain, push, and React Native marshalling.

Previously, the client protocol and storage layer below the bridge was implemented twice: once in Kotlin (`kotlin/`, over SQLDelight and `libsignal-client` JNI) and once in Swift (`swift/`, over GRDB and `LibSignalClient` C FFI). Maintaining two implementations of the same state machine caused:

1. **Silent behavioural drift:** Even with conformance vectors (`client-protocol/conformance/`) and [`KIT_API.md`](KIT_API.md), the two kits diverged on receive envelope deduplication, SQLite string handling, WAL truncation, and push drain.
2. **Duplicated orchestration:** Over 60% of each kit was concurrency and orchestration (`ObscuraClient`, `AuthManager`, `MessageSender`, `Gateway`, `TypingTracker`), where every protocol change and bug fix had to be written and debugged twice.
3. **Cross-FFI transaction overhead:** Every message decrypt opened a SQLite transaction in Kotlin or Swift, crossed FFI into Rust `libsignal`, called back into Kotlin/Swift 5–10 times for store reads/writes, and then wrote to `ContentStore` in the host language.

## Why `obscura-core` Owns `ObscuraClient` End-to-End

`core/` (`obscura-core`) replaces both kits with one Rust implementation over `libsignal-protocol` and `rusqlite` (SQLCipher), exported to Kotlin and Swift via UniFFI:

- **One SQLite transaction for ratchet and content:** `SignalStore`, `DeviceStore`, `FriendStore`, and `ContentStore` share a single SQLCipher connection confined to one dedicated background actor thread per client. Decryption, identity-reset cascades, envelope deduplication, and content persistence commit or roll back together without crossing FFI.
- **Off-thread prekey generation:** Batch Kyber-1024 prekey generation runs outside the SQLite actor thread so incoming messages never stall behind CPU-heavy key generation.
- **Post-commit foreign callbacks:** Foreign callbacks (`ObscuraLogger`, `ClientEventListener`) are never invoked inside a database transaction or while holding internal locks, preventing re-entrancy deadlocks and rolled-back event emissions.
- **OS-native HTTP and WebSocket transport:** Rather than bundling a second TLS and networking stack in Rust, `obscura-core` owns endpoint routing, JSON/protobuf codecs, 401 single-flight token refresh, 429/503 `Retry-After` backoff, and WebSocket reconnection state, while delegating raw HTTP and WebSocket I/O to a thin foreign `Transport` trait implemented with `OkHttp` on Android and `URLSession` on iOS (and an in-memory fake transport in Rust tests).
- **Replace, never coexist:** Linking two copies of SQLCipher into the iOS binary causes flat-namespace symbol collisions on `sqlite3_*`, and shipping `libobscura_core` alongside `libsignal_jni` and `libsqlcipher` on Android bloats the APK. Each platform switches to `obscura-core` whole.
