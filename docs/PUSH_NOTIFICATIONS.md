# Push notification rationale

## Why push wakes and local notifications are content-free

OS notification databases and cloud backups persist notification text and deep-link
extras outside the app's encrypted storage, and push providers (FCM/APNs) see
every push payload in transit.

- **Silent wakes only:** The server sends only a content-free wake signal so
  FCM/APNs never learn who sent a message, what model it was, or which
  conversation changed.
- **Generic local copy only:** Even after the device decrypts pending envelopes
  locally, notifications posted to the OS contain only generic copy (`New pix`,
  `New message`, `New friend request`) and a generic destination (`screen=chat`).
  Usernames, captions, message previews, thumbnails, and user/message IDs are
  never placed into OS notification payloads or tap intents.
- **Single notification slot:** Reusing one notification ID replaces the prior
  banner rather than accumulating a visible count or history of received items on
  the lock screen.
- **Process-scoped background drain:** On Android, an FCM data message wakes the
  process without mounting React Native. `ObscuraSession` restores the kit
  session and drains envelopes ([kit push](KIT_API.md#typing-attachments-and-push))
  within the service execution budget, posting generic copy only while the app
  is backgrounded.

## Server contract

```text
PUT /v1/push-token
Authorization: Bearer <device-scoped JWT>
