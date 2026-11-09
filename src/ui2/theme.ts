// claude: port of the theme model in react-native-experiments/design/obscura-ui/index.html (`:root` tokens,
// PALETTES, SHADE, apply()). Pure: no React, no React Native.

export type Mode = 'light' | 'dark';

export type PaletteName =
  | 'Sunny'
  | 'Bubblegum'
  | 'Mint'
  | 'High contrast'
  | 'Low contrast'
  | 'Grape';

export interface Palette {
  name: PaletteName;
  blue: string;
  yellow: string;
  darkYellow: string;
  alert: string;
  darkPanel: string;
  bar: string;
  darkBar: string;
  black?: string;
  white?: string;
}

export const SHADE = { light: '#FFFFFF', dark: '#262A34' } as const;

export const PALETTES: readonly Palette[] = [
  { name: 'Sunny', blue: '#62C6F3', yellow: '#FFD21A', darkYellow: '#FFD21A', alert: '#FF4FA3', darkPanel: '#283346', bar: '#23272F', darkBar: '#121418', black: '#262A34' },
  { name: 'Bubblegum', blue: '#FF92CE', yellow: '#DBFA75', darkYellow: '#CDFF80', alert: '#FF92CD', darkPanel: '#000000', bar: '#291D3A', darkBar: '#342C39', black: '#000000' },
  { name: 'Mint', blue: '#7EDDB8', yellow: '#FFC94A', darkYellow: '#FFC94A', alert: '#FF7FD1', darkPanel: '#24302B', bar: '#121A17', darkBar: '#0E1512', black: '#262A34' },
  { name: 'High contrast', blue: '#EAEAEA', yellow: '#FFD21A', darkYellow: '#FFD21A', alert: '#FF5EC3', darkPanel: '#1C1C1C', bar: '#000000', darkBar: '#000000', black: '#000000', white: '#FFFFFF' },
  { name: 'Low contrast', blue: '#ECECEC', yellow: '#FFD21A', darkYellow: '#FFD21A', alert: '#FF86D0', darkPanel: '#383838', bar: '#282828', darkBar: '#1F1F1F', black: '#000000', white: '#FFFFFF' },
  { name: 'Grape', blue: '#B79CF2', yellow: '#FFD21A', darkYellow: '#FFD21A', alert: '#FF4FA3', darkPanel: '#2A2738', bar: '#17141F', darkBar: '#120F19', black: '#262A34' },
];

const SUN_INK = '#1A1400';
const REC = '#FF0000';

const channels = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) {
    throw new Error(`ui2/theme: expected #RRGGBB, got ${hex}`);
  }
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const toHex = (c: number) => Math.round(c).toString(16).padStart(2, '0').toUpperCase();

// claude: CSS `color-mix(in srgb, a percentA%, b)`.
export function mixHex(a: string, percentA: number, b: string): string {
  const w = percentA / 100;
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca.map((v, i) => toHex(v * w + cb[i] * (1 - w))).join('')}`;
}

// claude: CSS `color-mix(in srgb, color percent%, transparent)` as #RRGGBBAA.
export function withAlpha(color: string, percent: number): string {
  channels(color);
  return `${color.toUpperCase()}${toHex((percent / 100) * 255)}`;
}

export interface ColorTokens {
  white: string;
  black: string;
  yellow: string;
  blue: string;
  alert: string;
  sky: string;
  paper: string;
  ink: string;
  sun: string;
  sunInk: string;
  pix: string;
  rec: string;
  link: string;
  cream: string;
  inkSoft: string;
  muted: string;
  line: string;
  outline: string;
}

export interface ResolvedTheme extends ColorTokens {
  palette: PaletteName;
  mode: Mode;
  shadeWhite: string;
  bar: string;
  barLight: string;
  barIcon: string;
  onSecondary: ColorTokens;
}

const derive = (
  base: { white: string; black: string; yellow: string; blue: string; alert: string; outline: string },
): ColorTokens => ({
  ...base,
  sky: base.blue,
  paper: base.white,
  ink: base.black,
  sun: base.yellow,
  sunInk: SUN_INK,
  pix: base.alert,
  rec: REC,
  link: base.blue,
  cream: mixHex(base.white, 93, base.yellow),
  inkSoft: mixHex(base.black, 78, base.white),
  muted: mixHex(base.black, 48, base.white),
  line: mixHex(base.black, 8, base.white),
});

export function resolveTheme(paletteName: PaletteName, mode: Mode): ResolvedTheme {
  const p = PALETTES.find(x => x.name === paletteName);
  if (!p) {
    throw new Error(`ui2/theme: unknown palette ${paletteName}`);
  }
  const s = { light: p.white ?? SHADE.light, dark: p.black ?? SHADE.dark };
  const dark = mode === 'dark';
  const white = dark ? p.darkPanel : s.light;
  const black = dark ? s.light : s.dark;
  return {
    ...derive({
      white,
      black,
      yellow: dark ? p.darkYellow : p.yellow,
      blue: p.blue,
      alert: p.alert,
      outline: dark ? black : p.bar,
    }),
    palette: p.name,
    mode,
    shadeWhite: dark ? s.dark : s.light,
    bar: dark ? p.darkBar : p.bar,
    barLight: p.bar,
    barIcon: mixHex(s.light, 88, s.dark),
    onSecondary: derive({
      white: s.light,
      black: s.dark,
      yellow: p.yellow,
      blue: p.blue,
      alert: p.alert,
      outline: p.bar,
    }),
  };
}

// claude: dark-mode overlays, the board's defaults: a fixed color at a percent opacity.
export const DARK_OVERLAY = {
  // claude: Ryan, on device: the message box and + button are black, at these opacities, in dark mode too
  messageOutline: { color: '#000000', alpha: 28 },
  // claude: the message box text stays white
  messageText: { color: '#FFFFFF', alpha: 75 },
  messageBackground: { color: '#000000', alpha: 56 },
  chatName: { color: '#FFFFFF', alpha: 89 },
  incomingBubble: { color: '#FFFFFF', alpha: 12 },
  plusButton: { color: '#000000', alpha: 95 },
  avatarOutline: { color: '#FFFFFF', alpha: 17 },
  barOutline: { color: '#FFFFFF', alpha: 8, width: 1.5 },
} as const;
