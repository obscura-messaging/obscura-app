import { useColorScheme } from 'react-native';
import { create } from 'zustand';
import { resolveTheme, type PaletteName, type ResolvedTheme } from './theme';
import type { SampleSize } from './sample';

export type ThemeMode = 'system' | 'light' | 'dark';

interface Ui2State {
  mode: ThemeMode;
  palette: PaletteName;
  // claude: profile emoji/color need a data field; null shows the letter and the username's color.
  emoji: string | null;
  color: string | null;
  // claude: dev sample data (sample.ts); null shows real data.
  sample: SampleSize | null;
}

// claude: in memory only; persistence is pending.
export const useUi2 = create<Ui2State>(() => ({ mode: 'system', palette: 'Sunny', emoji: null, color: null, sample: null }));

export const setThemeMode = (mode: ThemeMode) => useUi2.setState({ mode });
export const setPalette = (palette: PaletteName) => useUi2.setState({ palette });
export const setProfileEmoji = (emoji: string) => useUi2.setState({ emoji });
export const setProfileColor = (color: string) => useUi2.setState({ color });

export function useUi2Theme(): ResolvedTheme {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const mode = useUi2(s => s.mode);
  const palette = useUi2(s => s.palette);
  return resolveTheme(palette, mode === 'system' ? system : mode);
}
