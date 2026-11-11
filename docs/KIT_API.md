# Kit contract

The Kotlin and Swift kits implement this contract. It is the one Markdown file
that states **what**, not only why: with two implementations, neither kit's code
can be the authority for the other, so the behaviour both must share lives
here. Signatures belong to each kit's code; this file covers only behaviour a
peer, the server or the other kit can observe.

| Layer | Defined by |
|---|---|
| Transport | [`obscura.proto`](https://github.com/obscura-messaging/obscura-proto/blob/main/obscura/v1/obscura.proto), [`TRANSPORT.md`](https://github.com/obscura-messaging/obscura-proto/blob/main/TRANSPORT.md) |
| End-to-end client content | [`client.proto`](../client-protocol/obscura/client/v1/client.proto) |
| Kit behaviour | this document |
| Application models | [`DOMAIN_CONTRACT.md`](DOMAIN_CONTRACT.md) |

## Kit boundary

The kit owns authentication, device provisioning, Signal sessions, the friend
graph, REST and gateway transport, typing, attachment encryption, and the typed
content store (`ConversationEntry`, `StoryEntry`, `ProfileEntry`,
`ErasedEntry`, and `ProcessedEnvelope`), including audience resolution, merge,
expiry, and the outbox.

Hosts own OS lifecycle, secure session storage, files, permissions, push, and
notifications.

**Every client-to-client message is a typed protobuf message declared in
`client.proto`.** Kits do not post OS notifications.

Wire mappings live in each kit's `WireCodec` and are checked against
[`wire.json`](../client-protocol/conformance/wire.json). Typing maps only
STARTED/STOPPED; unspecified states are ignored. The device-link envelope
derivation and link code encoding are checked against
[`link.json`](../client-protocol/conformance/link.json).

## Construction and persistence

Every client requires a host-provided `SessionStorage`.

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
account identity key pair; linking imports the account's. Either way the device
gets a fresh registration id, a signed prekey, a last-resort Kyber prekey, and
100 one-time prekeys of each kind (EC and Kyber), all signed by the account
identity key pair. Sessions use PQXDH, which libsignal requires.

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
and last-resort Kyber prekeys, one-time EC and Kyber prekeys, and Signal sessions.

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
  signed and Kyber prekey signatures (`PROTOCOL_VIOLATION` otherwise).
- The server allows a device 6 bundle fetches of the same target per 10
  minutes. A `429` asking for a longer wait than 10 s is thrown, not retried.
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

Every REST operation retries 429/503 at most twice, waiting `Retry-After`
seconds with a floor of 1 s; absent or unparsable values mean 1 s, so the
server's sub-second `Retry-After: 0` never causes an immediate retry. A wait
longer than 10 s (such as the bundle-fetch limit's) is not worth holding a
request open for, so it throws instead. Other non-2xx responses throw with
their status and body.

## Observation

| Surface | Meaning |
|---|---|
| `authState`, `connectionState` | Current state and a stream yielding the current value, then changes |
| `friendsChanged` | Payload-free wake-up, including subscription; call `getFriends()` |
| `messageReceived` | One buffered single-consumer stream of model keys |
| `observeTyping(contextId)` | Current distinct typing user ids, sorted, then changes |
| `getDebugLog()` | Up to 200 lines, newest first |

`messageReceived` yields the model key (`directMessage`, `pix`, `seen`, `story`,
`profile`) once per newly stored content update, never for a duplicate or
another payload arm. Capacity is 100, dropping oldest wake-ups: the local SQLite
content store, not the stream, is the delivery path. Hosts refresh and sweep on
cold start, foreground, and reconnect as well.

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
acknowledged without another wake-up.

**Prekeys** follow Signal-Android's `PreKeysSyncJob`, so the server only stores
and serves them. A sync asks the server how many one-time prekeys of each kind
it holds for this device (`GET /v1/keys`), uploads a batch of 100 of any kind
below 10, rotates the signed and last-resort Kyber prekeys together once they are 2 days
old, and uploads it all in one `POST /v1/keys`. It runs after a prekey
message this device receives, on connect when the last sync is 2 days old, and
every 6 hours while signed in, because bundle fetches use keys up without any
message to say so. Syncs run one at a time, at least 30 seconds apart, so a
backlog of prekey messages costs one or two checks; failures are logged. As on
Signal-Android, a sync after a failed upload generates fresh keys, and the unsent
ones are cleaned up like any replaced keys. Ids start at a random point
and wrap at 2^24 - 1; one-time and last-resort Kyber prekeys share one counter.
Replaced keys stay for messages in flight: one-time keys for 90 days (keeping at
least 200 of each kind), signed and last-resort keys for 30 days, the server's
queued-message TTL (keeping the youngest older one). A first message that reuses
a base key with a last-resort Kyber prekey is rejected as a replay.

For inboxed content and local-only friend transitions, Signal ratchet/prekey
changes and their directory, inbox, or friend writes commit together. A local
storage failure rolls them back so the server's encrypted copy can still
decrypt on redelivery. Network-dependent control replies run outside the
transaction.

| Payload | Handling |
|---|---|
| `DIRECT_MESSAGE`, `PIX`, `SEEN_RECEIPT`, `STORY`, `PROFILE` | Validated and merged into local content tables (`ConversationEntry`, `StoryEntry`, `ProfileEntry`) inside the decrypt transaction |
| `FRIEND_REQUEST`, `FRIEND_ACCEPT` | Kit-internal friend transition |
| `TYPING_SIGNAL` | Ephemeral, no stored row |
| `FRIEND_LIST_SYNC` | Kit-internal: replaces the friend list if sent by the account's primary with a newer version, otherwise ignored |
| Unknown/unset arm | Logged and acknowledged without a stored row |

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

## Content store, outbox, and expiry

1:1 messages (`DirectMessage`, `PixMessage`) and `SeenReceipt` target the
accepted friend `peerUserId` plus self-sync. Stories (`StoryPost`) and profile
updates (`ProfileUpdate`) target all accepted friends plus self-sync. When a
send fails to reach its required audience, the local row is marked
`undelivered = 1`, `SEND_FAILED` is thrown, and `flushOutbox()` retries it on
reconnect or foreground.

`sweepExpired()` deletes expired conversation and story rows with
`PRAGMA secure_delete = ON`, records their IDs in `ErasedEntry`, truncates the
WAL, purges expired media files from `attachmentCacheDir`, and returns the set
of `touchedModels`.

## Typing, attachments and push

`sendTyping(recipients, contextId, state)` requires authentication and a
nonblank opaque context. It sends to distinct peers other than self,
throttled to once per 2 s per `(context, state)`. Per-recipient delivery
failures are logged and ignored.

Received `STARTED` lasts 5 s from receipt, renewed per sender device;
`STOPPED` clears that device. Typing is client-local, cleared on logout,
and never authorizes recipients or parses a conversation.

Each upload gets a fresh AES-256-GCM key and nonce, which travel only
inside the end-to-end encrypted entry. The app layer never handles them:
it sends a capture by path and downloads by entry id, so the keys stay in
the kit's encrypted database. `registerPushToken` registers the host's
token.

Android's `processPendingMessages(timeoutMs)` connects/reuses the receive
path and waits within its budget. It returns processed-envelope count,
including redeliveries, and 0 when connection fails; 0 is not proof that
the server queue is empty. It does not consume application inbox rows.
There is no Swift push-drain API without an implemented iOS push host.

## Errors

Both kits use the same deliberate error codes: the `ObscuraErrorCode` union in
[`ObscuraModule.ts`](../src/native/ObscuraModule.ts), which `exports.test.ts`
checks against both kits. HTTP errors retain status/body; other classified
errors retain useful details. Underlying database, filesystem and cryptographic failures
propagate rather than becoming success or silent defaults. Bridges preserve
kit codes and use per-method codes for unclassified platform failures.
