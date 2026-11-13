# Obscura

End-to-end encrypted messaging over ObscuraKit ([`kotlin/`](kotlin/), [`swift/`](swift/)).
Android and iOS both ship. iOS does not have push yet
([`docs/IOS_PARITY.md`](docs/IOS_PARITY.md)).

A **pix** is a direct, disappearing photo or video message, not the app's name.

## Layer boundaries

Code and tests are the authority on behaviour; Markdown documents explain only
**why** boundaries and constraints exist. The exception is
[`docs/KIT_API.md`](docs/KIT_API.md), the behaviour contract both kits implement.

- **Bridge & storage (`src/native/`, `android/`, `ios/`):**
  Native hosts manage OS lifecycle, permissions, files, push, and React Native
  marshalling, exposing typed domain operations over ObscuraKit.
- **Domain (`src/domain/`):** Pure, synchronous logic and narrowed view-model
  projections. Independent of React, React Native, native bridges, and stateful
  orchestration. Domain types make invalid UI states unrepresentable before
  data reaches a screen.
- **State (`src/state/`):** Orchestrates native domain operations, bridge
  events, and domain projections into reactive Zustand state and actions.
- **UI (`src/screens/`, `src/components/`, `src/navigation/`):** Renders domain
  projections and dispatches actions. Enforced by ESLint (`no-restricted-imports`),
  UI code cannot import the native bridge directly.

## Rationale & guides

- [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md): why the domain rules are
  shaped as they are.
- [`docs/BRIDGE.md`](docs/BRIDGE.md): why the React Native bridge is constrained
  as it is ([kit contract](docs/KIT_API.md)).
- [`docs/PUSH_NOTIFICATIONS.md`](docs/PUSH_NOTIFICATIONS.md): push privacy
  rationale.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): setup, `just check`, and native pin.
- [`docs/ANDROID_DISTRIBUTION.md`](docs/ANDROID_DISTRIBUTION.md),
  [`docs/IOS_DISTRIBUTION.md`](docs/IOS_DISTRIBUTION.md): release builds.
- [`ROADMAP.md`](ROADMAP.md): product direction.
