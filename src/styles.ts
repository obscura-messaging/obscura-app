import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#000',
  surface: '#1a1a1a',
  surfaceMuted: '#333', // muted fills: pending avatars, disabled buttons, secondary borders
  accent: '#FFFC00',
  onAccent: '#000',     // text/icons on an accent (yellow) background
  text: '#fff',
  textSecondary: '#999', // list previews, secondary labels
  textDim: '#666',       // hints, timestamps, captions, placeholders
  textMuted: '#444',     // empty states, faint ids
  border: '#222',
  // Semantic status/feedback — one value each, shared by toasts, dots, and states.
  error: '#ef4444',
  success: '#22c55e',
  connected: '#22c55e',
  connecting: '#fbbf24',
  disconnected: '#ef4444',
};

export type Colors = typeof colors;

// claude: builds `s` from a colors object, so a screen can pass themed colors through useMemo.
export const sharedStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  input: {
    backgroundColor: c.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13,
    color: c.text, fontSize: 16, marginBottom: 12, borderWidth: 1, borderColor: c.border,
  },
  sectionTitle: {
    color: c.textDim, fontSize: 12, fontWeight: '700',
    marginTop: 20, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6,
  },
  primaryBtn: { backgroundColor: c.accent, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  primaryBtnText: { color: c.onAccent, fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    backgroundColor: c.surface, borderWidth: 1, borderColor: c.border,
    borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center',
  },
  secondaryBtnText: { color: c.text, fontWeight: '600', fontSize: 16 },
  dangerBtn: { borderWidth: 1, borderColor: c.error, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center' },
  dangerBtnText: { color: c.error, fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
});

/** Styles shared across screens; the rest live with their screen. */
export const s = sharedStyles(colors);
