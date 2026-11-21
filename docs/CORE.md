# Core rationale (`core/`)

Executable types, state machines, and tests in [`core/`](../core/),
[`server-proto/`](../server-proto/), and [`client-protocol/`](../client-protocol/)
are the authority on **what** `obscura-core` does. This document explains only
**why** the core's architecture and protocol invariants are shaped as they are.

## Why one Rust core replaces platform kits

Obscura shares its UI, state, and domain projections in TypeScript (`src/`),
while native hosts (`android/`, `ios/`) own OS lifecycle, permissions,
Keystore/Keychain, push, and React Native marshalling.

Implementing the client protocol and storage layer in one Rust crate
(`obscura-core`) over `libsignal-protocol` and `rusqlite` (SQLCipher) exported
via UniFFI avoids maintaining two parallel protocol, storage, and protobuf stacks:

- **One SQLite transaction for ratchet and content:** `SignalStore`,
  `DeviceStore`, `FriendStore`, and `ContentStore` share a single SQLCipher
  connection confined to one dedicated background actor thread per client
  (`DbHandle`). Decryption, identity-reset cascades, envelope deduplication, and
  content persistence commit or roll back together with `PRAGMA synchronous = FULL`
  and zero FFI round-trips inside the transaction.
- **Off-thread prekey generation:** Batch Kyber-1024 prekey generation runs on
  the blocking thread pool outside the SQLite actor thread so incoming messages
  never stall behind CPU-heavy key generation.
- **Post-commit foreign callbacks:** Database transactions return
  `PostCommitEffect` values that are dispatched only after `COMMIT` succeeds and
  all internal locks are released, preventing re-entrancy deadlocks and
  rolled-back event emissions.
- **OS-native HTTP and WebSocket I/O:** Rather than bundling a second TLS and
  networking stack in Rust, `obscura-core` owns endpoint routing, JSON/protobuf
  codecs, `Idempotency-Key` headers, 401 single-flight token refresh, 429/503
  `Retry-After` backoff, and WebSocket reconnection state, while delegating raw
  HTTP and WebSocket I/O to a thin foreign `Transport` trait (`OkHttp` on
  Android, `URLSession` on iOS, and an in-memory fake server in Rust tests).
- **Replace, never coexist:** Linking two copies of SQLCipher into an iOS binary
  causes flat-namespace symbol collisions on `sqlite3_*`, and shipping
  `libobscura_core` alongside `libsignal_jni` and `libsqlcipher` on Android
  duplicates native binaries.

## Why sessions, identity trust, and delivery work as they do

- **Account-level identity trust with reset cascade:** All devices on an account
  share one Signal identity key pair (generated on the primary and transferred
  in `LinkBundle`), while each device has its own device UUID, registration ID,
  prekeys, and pairwise Signal sessions. Resolving identity trust by `userId`
  through the `devices` directory means an account reset (`POST /v1/users/reset`)
  atomically drops all stale sessions and old device entries for that user and
  notifies `identityChanged(userId)`.
- **Targeted bundle fetches:** Fetching a prekey bundle consumes a one-time EC
  and Kyber prekey on the server. Once a user has entries in `devices`, the
  sender fetches bundles only for devices missing a local session (`GET /v1/keys/{userId}/devices/{deviceId}`)
  and never processes a bundle over an existing session, which would reset its
  ratchet.
- **Server-verified device coverage:** Grouping outbound submissions by
  `Recipient` (`user_id`, including self-sync) lets the server reject incomplete
  device sets with `device_mismatches` while settling complete recipients in the
  first round, so the sender discovers newly linked peer or own devices without
  polling.
- **Persist-before-ack and `pending_friend_replies`:** Acknowledging an envelope
  deletes the server's copy, and committing `message_decrypt` spends the ratchet
  message key so a redelivery returns `DuplicatedMessage` without plaintext.
  Recording `pending_friend_replies` inside the decrypt transaction for crossed
  or re-added friend requests ensures that if the post-transaction network reply
  fails before acknowledgement, redelivery completes the reply before
  acknowledging.
- **Retry-safe expiry and WAL truncation:** Recording expired attachment IDs in
  `pending_media_purges` inside the `sweepExpired` transaction (with
  `PRAGMA secure_delete = ON`) and truncating the WAL afterwards guarantees that
  an interrupted sweep still purges cached media files on the next run.
