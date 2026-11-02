# Kit contract

The Kotlin and Swift kits implement this contract. Platform READMEs cover
toolchains and language-specific signatures, not different behavior.

| Layer | Defined by |
|---|---|
| Transport | [`obscura.proto`](https://github.com/obscura-messaging/obscura-proto/blob/main/obscura/v1/obscura.proto), [`TRANSPORT.md`](https://github.com/obscura-messaging/obscura-proto/blob/main/TRANSPORT.md) |
| End-to-end client content | [`client.proto`](../protocol/obscura/client/v1/client.proto) |
| Kit behavior and API | this document |
| Application models | [`DOMAIN_CONTRACT.md`](https://github.com/obscura-messaging/obscura-app/blob/main/docs/DOMAIN_CONTRACT.md) |

## Kit boundary

The kit owns authentication, device provisioning, Signal sessions, the friend
graph, REST and gateway transport, typing, attachment encryption, the durable
inbox, and the opaque entry store.

The app owns payload schemas, recipients, authorization, merge, expiry,
outbox policy, rendering, and notification policy. Hosts own OS lifecycle,
secure session storage, files, permissions, push, and notifications.

**If the kit reads a content field, it is declared in `client.proto`.**
Application payloads and `localMetadata` are opaque. Kits must not contain
application model names, infer recipients from payloads, implement an
application query/merge/expiry engine, or post OS notifications.

Wire mappings live in each kit's `WireCodec` and are checked against
[`wire.json`](../protocol/conformance/wire.json). `AppEntry` encoding
preserves model, id, timestamp and data; byte-canonical encoding is not
required. Typing maps only STARTED/STOPPED; unspecified states are ignored.
The device-link envelope derivation and link code encoding are checked against
[`link.json`](../protocol/conformance/link.json).

Takeover and device announcements do not exist.

## Construction and persistence

Every client requires a host-provided `SessionStorage`. There is no default
no-op store or UserDefaults token store. Swift also requires a logger.
In-memory construction helpers and stores are internal test infrastructure.

`SessionStorage` saves, loads, or clears one string-valued blob containing
exactly `token`, `refreshToken`, `expiresAt`, `userId`, `deviceId`, and `username`.
Storage failures propagate; Swift storage methods throw.

The kit is the only writer. It saves after successful authentication,
provisioning, and every token rotation. Logout, wipe, and refresh rejection
clear it. Refresh tokens are single-use, so writes must be durable before
authentication or refresh is reported successful.

`restorePersistedSession() -> Bool` loads the blob and requires a matching
local device identity and Signal identity. It restores credentials, refreshes
when necessary, and connects when possible. An unavailable network leaves a
usable session authenticated but disconnected. Missing or unusable storage,
or a rejected refresh token, returns false. Restore logs failures rather
than throwing; cancellation still cancels.

Before the first public release, schema changes can require clearing app
data. There are no compatibility migrations.

## Login, linking, and account reset

`AuthState` is `loggedOut` or `authenticated`.

| Operation / outcome | Behavior |
|---|---|
| `register(username, password)` | Creates the account and provisions this device as the primary with a new identity (`POST /v1/users`) |
| `login` -> `existingDevice` | Authenticates the stored local device (`POST /v1/session` with `deviceId`) |
| `login` -> `linkRequired` | No stored local device; verifies credentials and opens a link session (`POST /v1/link-sessions`), staying logged out |
| `login` -> `deviceMismatch` | Stored local device no longer belongs to this account (`409` on `POST /v1/session`) or lacks a local Signal identity; stays logged out |
| `login` -> `invalidCredentials` | Credentials rejected with 401/403; stays logged out |
| `beginLink(username, password, deviceName)` | After `linkRequired`: reuses the link session from `login` (or opens a new one) and returns a `LinkRequest` whose `code` is shown to the primary |
| `linkCodeDeviceName(code)` | Returns the `deviceName` encoded in a `LinkCode` without network I/O |
| `approveLink(code)` | Primary only (`NOT_PRIMARY` otherwise): encrypts the account identity, primary device id, versioned friend list, and `HistorySnapshot` into a `LinkEnvelope` and uploads it to the link session |
| `completeLink(request)` | Polls `GET /v1/link-sessions/{id}` until approved (`LINK_FAILED` on 404, expiry, or decryption failure), provisions this device via `POST /v1/devices` with keys signed by the account identity, imports friends and history, and connects |
| `resetAccount(username, password)` | Deletes all devices and replaces the account identity on the server while provisioning this device as the new primary (`POST /v1/users/reset`), wipes old local data, and installs the new primary session |
| `isPrimary` | Whether this device is the account's primary device |
| `devices()` | Lists the account's devices (`GET /v1/devices`), marking `isPrimary` and `isThisDevice` |
| `unlinkDevice(deviceId)` | Primary unlinks any other device (`INVALID_ARGUMENT` for itself); a linked device unlinks only itself (`NOT_PRIMARY` for others), then signs out and wipes local data |
| `logout()` | Disconnects, stops background work, clears credentials, storage and typing; keeps local data |
| `wipeDevice()` | Logs out, then deletes local Signal state, friends, devices, identity, entries and inbox |

Other HTTP failures throw. Registration and account reset generate a new
account identity key pair, registration id, signed prekey id 1, and 100
one-time prekeys; linking generates a fresh registration id, signed prekey id 1,
and 100 one-time prekeys signed by the imported account identity key pair.

Logout revokes the refresh token best-effort; failure is logged. Unlinking this
device or resetting the account skips server refresh-token revocation because
the server already deleted the device. Durable clears and wipes are not
best-effort.

**Token refresh** is internal. Concurrent callers share one in-flight
request. A 401 on any authenticated session request triggers this shared
refresh: if the refresh is rejected (401/403 or missing refresh token), the
device signs out and throws `NOT_AUTHENTICATED`; if it succeeds, the request is
retried once; network and 5xx failures keep the session. Background refresh
runs at 80% of remaining token lifetime, at least 5 s, with failure backoff
from 5 s doubling to 5 min. A completed refresh from a superseded session must
not restore credentials, overwrite storage, or sign out a newer session.

## Multi-device accounts, trust, and complete delivery

Each account has one Signal identity key pair shared by all its devices (up to
the server limit). Each device has its own device UUID, registration id, signed
prekeys, one-time prekeys, and Signal sessions.

The first device provisioned on an account is the **primary**. Only the primary
may link or unlink other devices or mutate the friend list (`addFriendByCode`,
`acceptFriend`, `removeFriend`). Linked devices are never promoted: losing the
primary requires `resetAccount`, which peers
observe as an account-level identity change.

There is one device directory keyed by `(userId, deviceId)`, including the
account's own devices. No parallel device list lives in a friend row or
in-memory cache.

**Discovery and complete delivery:**

- Every `POST /v1/messages` request groups submissions by `Recipient` (`user_id`
  and `submissions`, batching peer recipients and the sender's own `userId` for
  self-sync into one request per round), even for a user with no submissions.
- When the directory has no devices for a target user, the kit fetches all of
  that user's bundles (`GET /v1/keys/{id}`). Otherwise it fetches bundles only
  for target devices missing a Signal session, one device at a time
  (`GET /v1/keys/{id}/devices/{deviceId}`), so existing devices do not lose
  one-time prekeys.
- Processing a bundle over an established session would restart its ratchet and
  must not happen.
- All bundles for a user must carry the same account identity key and valid
  signed-prekey signatures (`PROTOCOL_VIOLATION` otherwise).
- If the server reports a user in `device_mismatches`, the kit adds
  `missing_device_ids` to the directory, establishes missing sessions, and
  retries only the mismatched users with a new `Idempotency-Key` (up to 3
  rounds). Users whose device sets were complete are settled in the first
  round. Devices listed in `invalid_device_ids` are removed from the directory.
- A successfully decrypted inbound envelope teaches the directory its
  server-stamped `(senderUserId, senderDeviceId)` pair before acknowledgement.

Peer identity is trusted per account (`userId`). When a peer's bundle or
prekey message presents a new identity key (after `resetAccount`), the kit
replaces the stored key for that user, deletes all Signal sessions and older
device directory entries for that user, and notifies `identityChanged(userId)`.

**Friend authority and sync:**

Only the primary processes `addFriendByCode`, `acceptFriend`, `removeFriend`,
and incoming `FRIEND_REQUEST` / `FRIEND_ACCEPT` messages. After every friend
list change, the primary increments the local friend-list version and sends a
full `FRIEND_LIST_SYNC` to its own account's linked devices. Linked devices
apply `FRIEND_LIST_SYNC` only when sent by their account's primary with a
strictly higher version. `removeFriend(userId)` removes the local relationship
and its device directory entries, sends nothing to the peer, and leaves
application entries alone.

## Connection and HTTP

`connect()` requires authentication and returns only when the socket is
open. It is idempotent, joins an in-flight attempt, and cuts short reconnect
backoff when called explicitly. The host calls it on foreground; the kit
does not observe OS lifecycle.

`disconnect()` closes the socket and stops reconnecting. An unrequested
drop or server close reconnects with 1 s doubling to a 30 s cap, refreshing
credentials before each attempt. Exactly one component owns reconnect.
Keepalive pings run every 30 s; a failed ping is a drop.

Every REST operation retries 429/503 at most twice. `Retry-After` seconds
are clamped to 1..10; absent or unparsable values mean 1 s. In particular,
the server's sub-second `Retry-After: 0` must not cause an immediate retry.
Other non-2xx responses throw with their status and body. There are no
unconditional request-pacing sleeps.

## Observation

| Surface | Meaning |
|---|---|
| `authState`, `connectionState` | Current state and a stream yielding the current value, then changes |
| `friendsChanged` | Payload-free wake-up, including subscription; call `getFriends()` |
| `messageReceived` | One buffered single-consumer stream of model keys |
| `observeTyping(contextId)` | Current distinct typing user ids, sorted, then changes |
| `getDebugLog()` | Up to 200 lines, newest first |

`messageReceived` yields once per newly inboxed `APP_ENTRY`, never for a
duplicate or another payload arm. Capacity is 100, dropping oldest wake-ups:
the inbox, not the stream, is the delivery path. Hosts drain on cold start,
foreground and reconnect as well.

Observers must be cancellable without blocking mutations or other
observers. Stream callbacks must not execute under a state lock.

## Receive: persist-then-ack

An acknowledgement deletes the server's copy. For each envelope:

1. Require 16-byte envelope, sender-user, and sender-device UUIDs.
2. Select the Signal session by the sender-device UUID and decrypt.
3. Record the authenticated sender device and classify the content.
4. Persist the inbox row or complete the internal handler.
5. Wake the host for a newly inserted application row, then acknowledge.

Malformed identity, failed decrypt, or failed durable handling is logged
and not acknowledged, except a duplicate-message decrypt error: decrypt commits
only together with its durable writes, so a spent message key proves the
envelope is already stored, and it is acknowledged. Decrypted plaintext that
is not a `ClientMessage` is logged and acknowledged: its ratchet step is spent
and it can never parse.
An inbox duplicate counts as persisted and is
acknowledged without another wake-up. Prekeys below 20 trigger replenishment
of 50, with at most one upload in flight; failures are logged. Each refill
also generates a signed prekey with an id above every locally stored signed
prekey id, as required by the server. The identity stays unchanged. When an
upload succeeds, every older signed prekey is marked superseded at that time
(if not already), and those superseded 30 days ago or more, the server's
queued-message TTL, are deleted.

For inboxed content and local-only friend transitions, Signal ratchet/prekey
changes and their directory, inbox, or friend writes commit together. A local
storage failure rolls them back so the server's encrypted copy can still
decrypt on redelivery. Network-dependent control replies run outside the
transaction.

| Payload | Handling |
|---|---|
| `APP_ENTRY` | Inbox opaque `data`, model, id and timestamp (blank model or id is logged and ignored) |
| `FRIEND_REQUEST`, `FRIEND_ACCEPT` | Kit-internal friend transition |
| `TYPING_SIGNAL` | Ephemeral, no inbox row |
| `FRIEND_LIST_SYNC` | Kit-internal: replaces the friend list if sent by the account's primary with a newer version, otherwise ignored |
| Unknown/unset arm | Logged and acknowledged without an inbox row |

A request from an unknown sender becomes pending-received. Crossed
requests accept the friendship. Other requests do not relabel known
peers. A request from an already accepted account gets an idempotent
accept reply without changing that relationship, so a peer that reset
its account can explicitly re-add the peer. An accept promotes only a
pending-sent relationship.

Outgoing requests are recorded as pending-sent before submission, so a fast
accept cannot arrive before local intent exists. Failure cleanup must not
undo a relationship accepted while submission was in flight.

Incoming entry timestamps are capped at local `now + 60 s`. The inbound
Signal address is `(senderDeviceUUID, 1)`; attribution comes from this
session and the server envelope, never application data.

## Envelope identity

The server stamps sender user and device UUIDs from the device-scoped
credential. Signal decrypt uses that device's session, never a guessed
device, registration id, payload identity, or fallback bundle.
The app authorizes the inbox using this attribution; successful transport
delivery alone does not authorize an application write.

## Inbox

`peek(limit)`, `consume(ids)`, `discard(ids, reason)`, and `depth()` are
the public API. Insert is internal.

Rows contain a local monotonic `id`, authenticated sender user/device,
model, entry id, timestamp, and opaque bytes. Peek is stable oldest-first
and has no side effects. Consume/discard are idempotent and accept partial
batches. Discard logs its reason.

Envelope ids are unique while pending, preventing duplicate insertion or
notification. Consumed ids are not retained as tombstones: application
merge must be idempotent.

An app drain peeks a bounded batch, validates and authorizes, merges and
writes entries, then consumes. No transaction spans entries and consume;
a crash can replay a row. Transient failures leave rows pending; permanent
rejections are discarded explicitly. The app monitors abnormal inbox depth.

## Entry store

`put(model, entry)`, `get(model, ids)`, `all(model)`, `erase(model, ids)`.

`StoredEntry` contains id, opaque data, timestamp, author user, author device,
and nullable opaque `localMetadata`. Put is a blind upsert. Merge is the app's
job. Local metadata never enters the wire payload.

Get returns named rows that exist. Erase enables `secure_delete` on the
deleting connection, deletes in bounded batches, then checkpoints and
truncates the WAL once per call. It must remove recoverable content from
both main database and WAL, not merely make rows invisible. An empty erase
is a no-op. Durable deletion failures propagate.

## Send

`send(recipientUserIds, modelKey, entryId, sentAt, payload)`
returns `SendReport { recipients, selfSync }`.

The kit never infers or broadens recipients. Duplicates and the sender's
own user id are excluded from peer recipients. Peer recipients and the
sender's own user id (for self-sync) are batched into one `POST /v1/messages`
request per round, and the kit never writes a local entry.

Each result has user id, nullable device id, status
(`accepted`, `rejected`, `unknown`), and optional error.
Accepted means queued by the server, not delivered or viewed. Bundles or
encryption failures are rejected; uncertain submission outcomes are unknown.
HTTP 200 alone is not enough: the server's `invalid_device_ids` and
`device_mismatches` are decoded.
Pre-processing HTTP 400 and 413 responses reject the affected submissions;
401, 403, transport failures, server failures, and unusable responses leave
them unknown, because they describe the session or the attempt, not the
message.

A missing device list is a rejected user-level result, not empty-audience
success. Self-sync/discovery failure cannot prevent peer attempts or
invalidate their acceptance.

The kit owns no send queue. Durable retries, audience policy, versioning,
and expiry belong to the app.

## Typing, attachments and push

`sendTyping(recipients, contextId, state)` requires authentication and a
nonblank opaque context. It sends to distinct peers other than self,
throttled to once per 2 s per `(context, state)`. Per-recipient delivery
failures are logged and ignored.

Received `STARTED` lasts 5 s from receipt, renewed per sender device;
`STOPPED` clears that device. Typing is client-local, cleared on logout,
and never authorizes recipients or parses a conversation.

`uploadAttachment` encrypts with fresh AES-256-GCM key/nonce and returns
id/key/nonce. Download returns decrypted bytes; kits keep no decrypted
cache. `registerPushToken` registers the host's token.

Android's `processPendingMessages(timeoutMs)` connects/reuses the receive
path and waits within its budget. It returns processed-envelope count,
including redeliveries, and 0 when connection fails; 0 is not proof that
the server queue is empty. It does not consume application inbox rows.
There is no Swift push-drain API without an implemented iOS push host.

## Errors

Both kits use these deliberate error codes:

`NOT_AUTHENTICATED`, `INVALID_ARGUMENT`, `INVALID_FRIEND_CODE`,
`HTTP_ERROR`, `CONNECTION_FAILED`, `SEND_FAILED`, `PROTOCOL_VIOLATION`,
`STORAGE_ERROR`, `NOT_PRIMARY`, `LINK_FAILED`.

HTTP errors retain status/body; other classified errors retain useful
details. Underlying database, filesystem and cryptographic failures
propagate rather than becoming success or silent defaults. Bridges preserve
kit codes and use per-method codes for unclassified platform failures.
