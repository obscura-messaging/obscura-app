# Application domain rationale

Executable types, projections, and tests in `src/domain/`, `src/state/`, and
ObscuraKit ([`KIT_API.md`](KIT_API.md)) define application behaviour. This
document records only **why** those boundaries and invariants exist.

## Why the kit owns typed domain storage and wire encoding

ObscuraKit ([`KIT_API.md`](KIT_API.md)) handles Signal sessions, transport,
protobuf wire encoding, encrypted SQLite storage, merge, outbox retries, and
expiry behind typed domain operations (`ConversationItem`, `StoryItem`,
`ProfileItem`). Keeping wire encoding, transactional storage, and expiry inside
the kits eliminates cross-bridge JSON round-trips and multi-step JS lock ordering,
while `src/domain/` remains pure view-model projection logic.

## Why attribution and authorization ignore payloads

Any authenticated account can deliver an envelope to any device.

- **Envelope attribution:** Author user and device IDs come strictly from the
  authenticated transport envelope, never from payload fields, so a peer cannot
  spoof authorship or manipulate `REPLACE` tie-breaks.
- **Why receive authorization does not check friendship:** The friend graph can
  lag behind message delivery (for example, when a friend acceptance and the
  first message race on the wire). Gating permanent drops on current
  friend-graph state would silently lose real mail. Instead, the kit persists
  authenticated domain records and friend-graph filtering happens at
  projection/render time in `src/domain/`.

## Why profile merge and local writes are monotonic

Peer clocks can skew up to the kit's 60 s clamp:

- **Idempotent merge:** Immutable records (`directMessage`, `pix`, `seen`,
  `story`) keep the first write; mutable `profile` records merge with `REPLACE`
  ordered by `(updatedAt, authorDeviceId)` so concurrent edits converge across
  devices regardless of arrival order.
- **Monotonic local `updatedAt`:** Stepping a local profile update at least 1 ms
  past any existing stored copy ensures a user's own edit wins locally and
  remotely even when a peer's clock was ahead.

## Why disappearing messages and receipts avoid synced deletes

- **Separate immutable receipts:** If marking a message or pix as seen rewrote
  the original record via `REPLACE`, either participant could mutate or roll back
  the message payload. Making `seen` its own immutable receipt authored by the
  recipient keeps both the original item and the receipt immutable, and capping
  `viewedAt` at the receipt's clamped `sentAt` prevents a peer from backdating
  or far-future-dating expiry.
- **Independent local expiry + tombstones:** Syncing delete messages would leak
  timing metadata and fail whenever a device is offline. Instead, every device
  runs the same expiry clock locally (`sweepExpired`) and records a tombstone
  before erasing, preventing a delayed self-sync or replayed envelope from
  resurrecting expired content.
- **Domain projection before presentation:** Presentation components never render
  unprojected records directly where sensitive fields could leak. Domain
  projections (`chatTimeline`, `friendActivities`, `storyGroups`,
  `friendProfileEntries`) strip viewer-only fields (such as pix captions) from
  chat timelines and omit seen incoming pix before data reaches React components,
  making accidental UI leaks impossible.

## Why primary authority is never promoted

Linked devices share the account's Signal identity key, which is generated on
the primary device. Promoting a linked device without rotating the account
identity would leave a lost or compromised primary trusted by peers. Losing the
primary therefore requires an account reset, which provisions a fresh identity
and surfaces a safety-number change to friends.
