# Obscura bridge contract

[`src/native/ObscuraModule.ts`](../src/native/ObscuraModule.ts) is the
authority on method signatures, record types and event shapes. This file covers
only what the types cannot express. Kit semantics behind each call are in
[`KIT_API.md`][kit].

## Rules

- **Paths, not bytes.** Files cross the bridge as absolute paths, never as
  base64.
- **Opaque payloads.** Neither bridge parses `dataJson`, `payloadJson`,
  `InboxRow.payload` or `StoredEntry.data`. `src/models/schema.ts` never crosses
  the bridge.
- **The caller names recipients.** `sendEntry`, `sendTyping` and `stopTyping`
  take user IDs.
- **Identity comes from the envelope.** `senderUserId` and `senderDeviceId`
  come from the kit ([Envelope identity][kit-identity]), never from a payload.
- **Flat shapes.** Every method returns a promise. Arguments and event fields
  are scalars or arrays of scalars; free-form objects cross as JSON strings.

## Rejections

A kit failure rejects with its `ObscuraErrorCode`. Any other failure rejects
with a per-method code such as `LOGIN_ERROR`, `INBOX_PEEK_ERROR` or
`ENTRY_PUT_ERROR`. `DIRECT_ROUTING_UNRESOLVED` is an app error and never crosses
the bridge.

## Methods

All methods exist on both platforms. Behavior beyond the types:

| Method | Behavior |
| --- | --- |
| `login` | Returns one of the four outcomes in [Login][kit-login]. Persists the session only for `existingDevice`. The app handles the other outcomes in `src/state/login.ts`: `deviceMismatch` calls `wipeDevice` then `loginAndProvision`. |
| `wipeDevice` | The kit logs out, clears its persisted session and securely wipes local data; the host releases the client. |
| `entryPut` | A blind upsert: the app merges first. It emits no event, so the app refreshes itself. |
| `entryGet`, `entryErase` | Take a list of IDs; missing IDs are skipped. Each `entryErase` call checkpoints the WAL, so erase in batches. |
| `sendEntry` | Resolves to a `SendReport` of per-device outcomes ([Send][kit-send]) and does not reject because nobody accepted. `src/domain/delivery.ts` decides whether the send failed. |
| `removeFriend` | Forgets the friend and their devices locally. Nothing is sent to them. |
| `observeTyping` | Emits `typingChanged` until `stopObservingTyping`. Observing the same conversation twice still leaves one observation. |
| `uploadAttachment` | Leaves the source file alone. `contentKey` and `nonce` are base64. |
| `purgeAttachment` | Deletes the cached `jpg`, `mp4` and `mov` files for the id and their `.tmp` files. The expiry sweep calls it before erasing an entry with media. |
| `resizeImage` | Re-encodes as JPEG with the largest side at most `maxDim`. It MUST apply EXIF orientation, bound peak memory (Android: two-pass `inSampleSize`; iOS: ImageIO thumbnailing), reject `maxDim <= 0`, clamp `quality` to `1..100`, and reject rather than hang on out-of-memory. |
| `writeTestImage` | Writes a solid-color JPEG, the no-camera fallback in `CameraScreen`. Rejects dimensions outside `1..8192`. |
| `requestPushPermission` | Resolves `true` only on a grant. **Android:** a grant also fetches the FCM token and emits `pushTokenReceived`. Below Android 13 there is no prompt. Rejects `NO_ACTIVITY` without a foreground activity. **iOS:** registers for remote notifications, but no token reaches JS. |
| `getLaunchIntent` | Returns the cold-start notification target once, then `null`. JS calls it on mount, because the bridge does not exist yet during a cold start. Always `null` on iOS. |
| `prewarmAudioSession` | **iOS:** activates the audio session so recording starts without a ~1.4 s delay. Idempotent. **Android:** no-op. |
| `deleteFile` | Best-effort. Resolves even when the file is missing. |
| `addListener`, `removeListeners` | Framework methods inherited by the TS interface from `NativeEventEmitter`. Android defines no-op stubs, and iOS inherits them from `RCTEventEmitter`. |

`resizeImage` and `writeTestImage` never modify their source.

`downloadAttachment` decrypts to `<cacheDir>/attachments/<safeId>.<ext>`, with
`ext` (`jpg`, `mp4` or `mov`) chosen from the content. That file is the device's
only decrypted copy. Implementations MUST sanitize the id to `[A-Za-z0-9_-]`. A
non-empty cached file is returned without downloading. Writes MUST be atomic:
write a sibling `.tmp` file, then rename it. Server blobs expire after 30 days,
but inbox rows never do ([Inbox][kit-inbox]), so an undrained row can outlive
its media.

## Events

All events share one stream, `ObscuraEvent`, keyed by `type`. The
`ObscuraEvent` union must match the `BridgeEvent` enum in each bridge.

| Event | Emitted when | JS reaction (`src/state/store.ts`) |
| --- | --- | --- |
| `connectionChanged` | The WebSocket state changes | On `connected`: drain, flush the outbox, sweep expiry |
| `authStateChanged` | Login, logout or a rejected refresh token | `loggedOut` resets the session. `authenticated` loads it and runs the cold-start sync. |
| `appStateChanged` | The process moves to foreground or background | On `active`: drain, flush, sweep |
| `launchedFrom` | A notification is tapped while the app runs (Android only) | Navigate |
| `friendsChanged` | The friend graph changes | Call `getFriends()` |
| `messageReceived` | An `APP_ENTRY` row is persisted | Drain |
| `typingChanged` | An observed conversation's typing set changes | Show the bubble only if `userIds` contains the conversation's friend |
| `pushTokenReceived` | A push token arrives or rotates (Android only) | Call `registerPushToken` |

`messageReceived` is a wake-up, not a delivery, and it may be dropped. That is
why the app also drains on cold start, reconnect and foreground.

On Android, a newly bound bridge first replays `appStateChanged`,
`authStateChanged`, `connectionChanged` and `friendsChanged`. On iOS, events
emitted before JS subscribes are dropped.

Both hosts wait for cold-start session restoration before resolving the
initial auth read. Session blobs are written only by the kit through an
encrypted Android adapter or the iOS Keychain adapter; token rotation is not
an application callback. Storage write/clear failures reject rather than
reporting success.

The process-scoped session, not the React Native bridge, consumes the kit's
single `messageReceived` stream. Recreating the bridge must not cancel that
stream or stop subsequent wake-ups.

Concurrent auth operations reject with `INVALID_ARGUMENT` instead of racing
different clients against the same session store.

## Adding a method or event

1. Add it to `ObscuraBridge` or `ObscuraEvent` in `ObscuraModule.ts`.
2. Implement it in `android/.../ObscuraBridgeModule.kt`.
3. Implement it in `ios/Obscura/ObscuraBridge.swift` **and declare it in
   `ObscuraBridge.m`**. Without the `.m` line it compiles but is invisible at
   runtime.
4. Mirror it in `src/native/__fixtures__/FakeObscuraBridge.ts`, which
   implements `ObscuraBridge`. The fake models this contract, not kit internals.
5. Emit events only through each bridge's `emit` helper.
6. If the types do not capture its behavior, add a row here.

[kit]: https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md
[kit-identity]: https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md#envelope-identity
[kit-login]: https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md#login
[kit-inbox]: https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md#inbox
[kit-send]: https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md#send
