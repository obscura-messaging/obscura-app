# Obscura

- Code, types, ESLint boundary rules, and automated tests (`just check`,
  `just core-check`) are the sole source of truth on **what** the app and
  `obscura-core` do. Markdown files explain only **why**.
- Keep strict boundaries between `core/`, `src/native/`, `src/domain/`,
  `src/state/`, and UI (`src/screens/`, `src/components/`, `src/navigation/`).
  Make invalid states unrepresentable in `core/` and `src/domain/` before data
  reaches UI.
- Read [`README.md`](README.md), [`docs/CORE.md`](docs/CORE.md),
  [`docs/DOMAIN_CONTRACT.md`](docs/DOMAIN_CONTRACT.md), and
  [`docs/BRIDGE.md`](docs/BRIDGE.md) for design rationale, and run `just check`
  and `just core-check` ([`CONTRIBUTING.md`](CONTRIBUTING.md)) before
  committing.
