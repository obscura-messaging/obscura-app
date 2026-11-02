# Obscura

End-to-end encrypted messaging over ObscuraKit ([`kotlin/`](kotlin/), [`swift/`](swift/)).
Android is the release target; iOS ships internal TestFlight builds and works in
the foreground without push ([`docs/IOS_PARITY.md`](docs/IOS_PARITY.md)).

A **pix** is a direct, disappearing photo or video message, not the app's name.
Its `pix` model key is part of stored and transmitted data and does not change
with the repository name.

## Layer boundaries

Code and tests are the authority on behaviour; Markdown documents explain only
**why** boundaries and constraints exist.

- **Bridge & storage (`src/native/`, `src/state/entryStore.ts`, `android/`, `ios/`):**
  Native hosts manage OS lifecycle, permissions, files, push, and React Native
  marshalling. `src/state/entryStore.ts` is the sole module allowed to read or
  write the kit's entry store (`Obscura.entryPut/Get/All/Erase`) so serialization
  and lock ordering cannot be bypassed.
- **Domain (`src/domain/`):** Pure, synchronous logic, model schemas, and
  narrowed view-model projections. Independent of React, React Native, native
  bridges, and stateful orchestration. Domain types make invalid UI states
  unrepresentable before data reaches a screen.
- **State (`src/state/`):** Orchestrates storage, bridge events, and domain
  rules into reactive Zustand state and actions.
- **UI (`src/screens/`, `src/components/`, `src/navigation/`):** Renders domain
  projections and dispatches actions. Enforced by ESLint (`no-restricted-imports`),
  UI code cannot import the native bridge, `entryStore`, or sync internals.

## Rationale & guides

- [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md): why the domain rules are
  shaped as they are.
- [`docs/BRIDGE.md`](docs/BRIDGE.md): why the React Native bridge is constrained
  as it is ([kit rationale](docs/KIT_API.md)).
- [`docs/PUSH_NOTIFICATIONS.md`](docs/PUSH_NOTIFICATIONS.md): push privacy
  rationale.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, `just check`, and native pin.
- [`docs/ANDROID_DISTRIBUTION.md`](docs/ANDROID_DISTRIBUTION.md),
  [`docs/IOS_DISTRIBUTION.md`](docs/IOS_DISTRIBUTION.md): tester builds.
- [`ROADMAP.md`](ROADMAP.md): product direction.
