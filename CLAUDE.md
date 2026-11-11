# Obscura

- Code, types, ESLint boundary rules, and Jest tests are the sole source of
  truth on **what** the app does. Markdown files explain only **why**, except
  [`docs/KIT_API.md`](docs/KIT_API.md): the behaviour contract both native kits
  implement, since neither kit's code can be the authority for the other.
- Keep strict boundaries between `src/native/`, `src/domain/`, `src/state/`,
  and UI (`src/screens/`, `src/components/`, `src/navigation/`). Make invalid
  states unrepresentable in `src/domain/` before data reaches UI.
- Read [`README.md`](README.md), [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md),
  and [`docs/BRIDGE.md`](docs/BRIDGE.md) for design rationale, and run
  `just check` ([`CONTRIBUTING.md`](CONTRIBUTING.md)) before committing.
