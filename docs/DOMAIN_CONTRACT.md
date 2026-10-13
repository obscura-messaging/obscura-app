# Application domain contract

These are the semantics the app owns in `src/models/`, `src/domain/` and
`src/state/`. The kit only stores and sends opaque bytes
([`KIT_API.md`](https://github.com/obscura-messaging/obscura-native/blob/be2b96538647164c9ba60675f3836b063b4fcf80/docs/KIT_API.md)).

## Models

| Model           | Merge   | Audience             | Inbound authorization                    | Expires        |
| --------------- | ------- | -------------------- | ---------------------------------------- | -------------- |
| `directMessage` | APPEND  | conversation         | conversation names self and sender       | yes            |
| `pix`           | APPEND  | conversation         | conversation names self and sender       | yes            |
| `seen`          | APPEND  | conversation         | conversation names self and sender       | with its entry |
| `story`         | APPEND  | all accepted friends | none; the transport sender is the author | 24 h after post |
| `profile`       | REPLACE | all accepted friends | entry ID is `profile_<senderUserId>`     | no             |

A `pix` is a direct photo or video message. The model key is independent of
the `obscura-app` repository name.

`src/models/schema.ts` is the executable source: `audienceFor` for sends,
`fieldsFor` for local writes, `modelRules` for the drain. Screen entry types
derive from it. Field types are `string`, `string?`, `number` and `number?`
(`?` means optional). A local write with a bad field throws, and a received
entry with one is discarded as `invalid-fields`. Fields prefixed `_` are not
checked, and undeclared fields are allowed. `_authorUserId` is local-only. It is
stripped before sending, and it is never read from a payload. A local write sets
it to this user, and the drain sets it to the transport sender.

## Audience

`src/domain/audience.ts` turns a declaration into the recipient user IDs for
`sendEntry`. When a required value is missing or malformed, it throws
`DIRECT_ROUTING_UNRESOLVED` and sends nothing. It never widens to a broadcast.

- **None declared:** every accepted friend.
- **`self`:** an empty list, which reaches only the author's other devices.
- **`recipient`:** a username looked up among accepted friends. An unknown name
  reaches nobody else.
- **`conversation`:** a canonical conversation ID that must name the local
  user, intersected with accepted friends.

### Canonical conversation ID

The two participant user IDs, sorted and joined with `_`. User IDs are UUIDs,
so they never contain `_`. `src/domain/conversation.ts` has the only
constructor and parser. The parser rejects any noncanonical ID, including a
reversed pair.

## Inbound authorization

Any authenticated account can deliver to any device. The drain therefore
authorizes against the inbox row's `senderUserId`, never a payload field.
Friendship is not required; names come from the friend graph at render time.

- A conversation entry must name both the local user and the sender. In a
  self-sync, the sender is the local user.
- A profile entry ID must equal `profile_<senderUserId>`.
- A story has no binding field. Its sender is its author.

## Drain

```text
peek -> classify -> parse -> validate fields -> authorize -> merge -> entryPut -> consume
```

A row that can never be processed is discarded with a reason: `unknown-kind`,
`unknown-model`, `missing-fields`, `unparsable-payload`, `invalid-fields` or
`unauthorized-sender`. A transient failure leaves the row pending, and a merge
loser is consumed without a write. Nothing is drained until `getUserId` returns
a value. The drain runs on cold start, reconnect, foreground and
`messageReceived`.

## Merge

`src/domain/merge.ts` merges by entry ID. Entry writes and `consume` share no
transaction, so merge must be idempotent.

- **APPEND:** the first write wins.
- **REPLACE:** the greater `sentAt` wins. On a tie, the lexicographically
  greater `authorDeviceId` wins. Equal on both is the same write.

`authorDeviceId` is the device whose session decrypted the entry, or this
device for a local write.

## Local writes

`src/state/writeEntry.ts` resolves the audience and validates fields first;
either may throw before anything is stored. It then writes locally, then sends.
A local write's `sentAt` is at least 1 ms after the stored copy's, so it wins
even when a peer's clock is ahead. When a send reaches nobody, the error is
rethrown. The entry is kept and marked undelivered in `localMetadata`, then
retried on cold start, reconnect and foreground.

## Disappearing messages

The rules for `directMessage` and `pix` are in `src/domain/seen.ts` and
`src/domain/expiry.ts`.

- **Seen.** The recipient writes a `seen` entry with ID
  `seen_<model>_<entryId>` and data `{ conversationId, viewedAt }`. A message
  counts as seen when it is on screen in the focused chat with the app in the
  foreground. A pix counts as seen when the viewer moves past it or closes. A
  receipt counts only if someone other than the entry's author wrote it, in the
  entry's conversation. `viewedAt` is capped at the receipt's `sentAt`. Screens
  read the result as `entry.viewedAt`.
- **Expiry.** An entry expires 15 minutes after it is seen, and no later than 30
  days after it is sent. Every device that holds it erases its own copy,
  receipt and decrypted media, including the sender's. No delete is synced.
- **View-once is not immediate erasure.** The pix viewer disables backward
  navigation and the chat hides received pix after they are seen. Stored
  entries and decrypted media remain until the expiry sweep erases them.
- **No resurrection.** Before erasing, a device records the entry in the
  local-only `_erased` model, and the drain consumes later writes for it
  without storing them. Markers are pruned after 30 days, as are receipts whose
  entry never arrived.
- **Stories.** A story has no receipts. It expires 24 hours after it was
  posted, on every device, with the same marker and media purge. The stories
  row hides an expired story until the sweep erases it.
- **Sweep.** `src/state/expiry.ts` runs on cold start, reconnect, foreground and
  every 30 s while signed in.
