# Push notifications

These rules apply on every platform, but only Android implements them so far
([iOS status](IOS_PARITY.md#push-delivery)).

## Privacy invariants

- The server sends only a silent wake, `{ "data": { "action": "check" } }`. It
  MUST NOT include an alert, title, body, sender, preview, attachment metadata
  or application identifier.
- The device posts only generic local copy: title `Obscura`, with the text
  `New pix`, `New message` or `New friend request`.
- Notification text and tap metadata MUST NOT contain usernames, captions, or
  conversation, sender or message IDs. They also MUST NOT contain thumbnails or
  any other content-derived value. A tap may name only a broad destination;
  Android uses `screen=chat`.

These rules hold even when a richer preview would help, because notification
content persists in OS databases and backups.

## Ownership

| Layer | Responsibility |
| --- | --- |
| Server | Stores one token per device. Sends a silent wake when that device's queue changes. |
| Kit | Registers the token and processes pending envelopes ([Push](https://github.com/obscura-messaging/obscura-native/blob/dbb081bb6b1e15316912263b7276ba72972104f0/docs/KIT_API.md#typing-attachments-and-push)). Never posts a notification. |
| Native host | Receives the wake, restores the session, drains, and posts generic copy while the app is backgrounded. |
| TypeScript app | Requests permission and registers every token it receives. |

## Server contract

```text
PUT /v1/push-tokens
Authorization: Bearer <device-scoped JWT>
Body: { "token": "<fcm-token>" }
```

Registration is per device and idempotent. Deleting a device removes its token,
and the server drops any token the provider rejects. The server and the app must
use the same Firebase project. The default FCM message (target omitted) is:

```json
{
  "data": { "action": "check" },
  "android": { "priority": "HIGH", "collapseKey": "obscura_check", "ttl": "604800s" },
  "apns": {
    "headers": { "apns-push-type": "background", "apns-priority": "5", "apns-collapse-id": "obscura_check" },
    "payload": { "aps": { "content-available": 1 } }
  }
}
```

The server's `OBSCURA_FCM_TTL_SECS` overrides the TTL.

## Android

- **`ObscuraSession`** owns the kit client for the whole process. It is the only
  consumer of `messageReceived`. It posts only while the app is backgrounded.
  A `pix` posts `New pix`, a `directMessage` posts `New message` and a
  newly pending friend request posts `New friend request` through the friend
  change stream. `story`, `profile` and `seen`
  post nothing. An unrecognised model posts `New message`.
- **`ObscuraMessagingService`** passes each wake to
  `ObscuraSession.onPushWake`, which runs `processPendingMessages` with a 25 s
  timeout.
- **`NotificationHelper`** builds every notification. It uses one fixed ID, so a
  new notification replaces the previous one.
- **Tokens.** Granting permission fetches a token. Firebase `onNewToken` passes
  on rotations without checking the permission, and JS registers every token.
  Logout clears the local session but keeps the server device and its token.

Test by sending from another signed-in app while the receiving app is in the
background. The receiving device or emulator needs Google Play Services and a build with the real
`google-services.json` ([CONTRIBUTING](../CONTRIBUTING.md#setup-and-builds)).

## Not yet verified against the real provider

- Payloads stay silent and content-free.
- Background wakes drain; foreground delivery posts no notification.
- Copy and tap metadata hold no identities or content.
- Permission denial followed by token rotation has an explicit, tested policy.
- Deleting a device stops later pushes.
