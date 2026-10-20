# Obscura

End-to-end encrypted messaging: a React Native app over ObscuraKit, the
Kotlin and Swift kits in the [`obscura-native`](obscura-native/) submodule.
Android is the release target. iOS ships internal TestFlight builds and works in
the foreground; push is not implemented ([iOS status](docs/IOS_PARITY.md)).

The product is **Obscura**; `obscura-app` is this repository. A **pix** is a
direct, disappearing photo or video message, not the app's name. Its `pix`
model key is part of stored and transmitted data and does not change with the
repository name.

## Ownership

| Layer | Owns |
| --- | --- |
| TypeScript app (`src/`) | Model schemas, payload parsing, audience, authorization, merge, expiry, outbox, rendering |
| ObscuraKit | Auth, friends/devices, Signal, transport, typing, attachment encryption, durable inbox, opaque entry store |
| Android/iOS hosts | OS lifecycle, permissions, files, push, local notifications, React Native marshalling |

Never move application semantics into native code. Contracts:
[`DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md) (app),
[`BRIDGE.md`](docs/BRIDGE.md) (React Native bridge),
[`KIT_API.md`](https://github.com/obscura-messaging/obscura-native/blob/41395061762b37da748618f34bbac3221e537883/docs/KIT_API.md) (kit).

## Where things live

| Responsibility | Path |
| --- | --- |
| Models | `src/models/schema.ts` |
| Conversation IDs, audience, field types | `src/domain/{conversation,audience,fields}.ts` |
| Authorization and drain planning | `src/domain/drain.ts` |
| Merge | `src/domain/merge.ts` |
| Seen receipts and expiry rules | `src/domain/{seen,expiry}.ts` |
| Inbox drain, writes and outbox, expiry sweep, login | `src/state/{drainInbox,writeEntry,expiry,login}.ts` |
| Session, events and reactive state | `src/state/store.ts` |
| Bridge facade | `src/native/ObscuraModule.ts` |
| Native hosts | `android/app/src/main/java/dev/barrelmaker/obscura/`, `ios/Obscura/` |

## Docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, checks, workflow, native pin.
- [`PUSH_NOTIFICATIONS.md`](docs/PUSH_NOTIFICATIONS.md): push privacy and transport.
- [`ANDROID_DISTRIBUTION.md`](docs/ANDROID_DISTRIBUTION.md),
  [`IOS_DISTRIBUTION.md`](docs/IOS_DISTRIBUTION.md): internal tester builds.
- [`ROADMAP.md`](ROADMAP.md): what is done and what is next.
