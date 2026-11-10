import { useMemo } from 'react';
import { NEW_UI } from './flag';
import { useUi2Theme } from './store';

// claude: the keys of `colors` in src/styles.ts. src/ui2 may not import src/styles, so callers pass `colors`.
export interface LegacyColors {
  bg: string;
  surface: string;
  surfaceMuted: string;
  accent: string;
  onAccent: string;
  text: string;
  textSecondary: string;
  textDim: string;
  textMuted: string;
  border: string;
  error: string;
  success: string;
  connected: string;
  connecting: string;
  disconnected: string;
}

// claude: lets the old screens follow the ui2 theme. With NEW_UI off it returns `current` unchanged.
export function useLegacyColors(current: LegacyColors): LegacyColors {
  const t = useUi2Theme();
  // claude: palette and mode determine every token, so the result keeps its identity between renders.
  return useMemo(
    () => (NEW_UI ? {
      ...current,
      bg: t.paper,
      surface: t.cream,
      surfaceMuted: t.line,
      accent: t.yellow,
      onAccent: t.sunInk,
      text: t.ink,
      textSecondary: t.inkSoft,
      textDim: t.muted,
      textMuted: t.muted,
      border: t.line,
    } : current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, t.palette, t.mode],
  );
}
