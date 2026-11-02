# Application domain rationale

Executable schemas, types, and tests in `src/domain/` and `src/state/` define
application behaviour. This document records only **why** those boundaries and
invariants exist.

## Why the kit is opaque

ObscuraKit ([`KIT_API.md`](KIT_API.md))
handles Signal sessions, transport, and encrypted SQLite storage, but never
interprets application models. Keeping model schemas, authorization, merge, and
expiry in TypeScript means application changes do not require coordinated Kotlin
and Swift releases or migrations across two native codebases.

## Why attribution and authorization ignore payloads

Any authenticated account can deliver an envelope to any device, and a peer can
put arbitrary JSON inside an encrypted payload.

- **Envelope attribution:** Author user and device IDs come strictly from the
  authenticated transport envelope, never from payload fields, so a peer cannot
  spoof authorship or manipulate `REPLACE` tie-breaks.
- **Why drain authorization does not check friendship:** The friend graph can
  lag behind message delivery (for example, when a friend acceptance and the
  first message race on the wire). Gating permanent inbox discards on current
  friend-graph state would silently drop real mail. Instead, drain authorization
  checks structural ownership (such as canonical conversation membership or
  profile ID prefix), and friend-graph filtering happens at projection/render
  time.
- **Why audience resolution fails closed:** A malformed or unresolvable target
  throws rather than falling back to a broader audience, so a bug can never
  widen a 1:1 message into a broadcast.

## Why merge and local writes work without cross-store transactions

Inbox consumption and entry-store writes do not share a database transaction,
and peer clocks can skew up to the kit's 60 s clamp:

- **Idempotent merge:** Because a crash between `entryPut` and `inboxConsume`
  replays the inbox row on the next drain, merge must be deterministic and
  idempotent (`APPEND` keeps the first write; `REPLACE` orders by
  `(sentAt, authorDeviceId)`).
- **Monotonic local `sentAt`:** Stepping a local write at least 1 ms past any
  existing stored copy ensures a user's own edit wins locally and remotely even
  when a peer's clock was ahead.
- **Locking:** Because `entryPut` is a blind upsert, `withEntryLock` serializes
  read-merge-write cycles so a concurrent drain cannot overwrite a local write
  with a stale snapshot.

## Why disappearing messages and receipts avoid synced deletes

- **Separate `APPEND` receipts:** If marking a message or pix as seen rewrote
  the original entry via `REPLACE`, either participant could mutate or roll back
  the message payload. Making `seen` its own `APPEND` entry authored by the
  recipient keeps both the original message and the receipt immutable, and
  capping `viewedAt` at the receipt's clamped `sentAt` prevents a peer from
  backdating or far-future-dating expiry.
- **Independent local expiry + tombstones:** Syncing delete messages would leak
  timing metadata and fail whenever a device is offline. Instead, every device
  runs the same expiry clock locally and records an `_erased` tombstone before
  erasing, preventing a delayed self-sync or replayed envelope from
  resurrecting expired content.
- **Domain projection before presentation:** Presentation components never read
  raw stored entries. Domain projections strip viewer-only fields (such as pix
  captions) from chat timelines and omit seen incoming pix before data reaches
  React components, making accidental UI leaks impossible.

## Why primary authority is never promoted

Linked devices share the account's Signal identity key, which is generated on
the primary device. Promoting a linked device without rotating the account
identity would leave a lost or compromised primary trusted by peers. Losing the
primary therefore requires an account reset, which provisions a fresh identity
and surfaces a safety-number change to friends.
