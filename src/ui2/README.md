# ui2

The next Obscura design system, built beside the current UI. Its source of truth is the design board in
`react-native-experiments/design/obscura-ui/index.html` and the curves in `react-native-experiments/docs/motion.md`.

- `theme.ts`: palettes, `resolveTheme(palette, mode)` and the dark-mode overlays. Pure TypeScript, no React.
- `motion.ts`: timing curves for Reanimated's `withTiming`.
- `store.ts`: the theme choice (mode, palette) and profile emoji and color, in memory; `useUi2Theme()` resolves the tokens.
- `flag.ts`: `NEW_UI`. While it is `false`, the app runs the current UI and nothing here is rendered.
- `screens/`: chat list, chat, camera, profile, friends, devices, status and the QR scanners. `components/`: the tab
  bar, the avatar, the profile sheets and `Page`, the shell for pushed screens.

## Import rule

ESLint enforces a wall in both directions. Files in `src/ui2/` must not import `src/styles` or
`src/components/`. Files in `src/screens/`, `src/components/` and `src/navigation/` must not import
`src/ui2/`. The one exception is `src/navigation/RootNavigator.tsx`, which imports `src/ui2/` to choose a UI.

## Handover

1. Flip `NEW_UI` to `true` and ship.
2. In a separate change, delete the old screens, `src/styles.ts`, the old components and the flag.
