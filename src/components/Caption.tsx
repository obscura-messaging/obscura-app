import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { logError } from '../utils/log';
import { clamp } from '../utils/gesture';

/**
 * The styled caption shared by the composer (PhotoPreviewScreen) and the viewer (StoriesScreen). It
 * travels as a JSON `CaptionMeta` in an entry's `captionMeta` field.
 */

// The blob stores a font index, resolved here to the closest system font on each platform.
const FONT_DEFS = [
  { label: 'Clean', ios: 'System', android: 'sans-serif' },
  { label: 'Comic', ios: 'Chalkboard SE', android: 'casual' },
  { label: 'Serif', ios: 'Georgia', android: 'serif' },
  { label: 'Script', ios: 'Snell Roundhand', android: 'cursive' },
  { label: 'Mono', ios: 'Menlo', android: 'monospace' },
];

export const CAPTION_FONTS = FONT_DEFS.map(
  f => Platform.select({ ios: f.ios, android: f.android, default: f.ios }) as string,
);

export const CAPTION_FONT_LABELS = FONT_DEFS.map(f => f.label);

export const CAPTION_COLORS = [
  '#ffffff', '#000000', '#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#af52de',
];

export type CaptionStyle = 'bar' | 'bold';

export interface CaptionMeta {
  style: CaptionStyle;
  /** 0..1 from the top: the bar's top edge, or the bold text's center. */
  y: number;
  // Bold only:
  /** 0..1 horizontal center. */
  x?: number;
  /** Radians. */
  rot?: number;
  scale?: number;
  color?: string;
  /** Index into CAPTION_FONTS. */
  font?: number;
}

export const DEFAULT_BAR: CaptionMeta = { style: 'bar', y: 0.72 };

const clamp01 = (v: number) => clamp(v, 0, 1);

export function parseCaptionMeta(raw?: string | null): CaptionMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (m && (m.style === 'bar' || m.style === 'bold') && typeof m.y === 'number') return m;
  } catch (e) {
    logError('caption.parse', e);
  }
  return null;
}

export function serializeCaptionMeta(meta: CaptionMeta): string {
  return JSON.stringify(meta);
}

export const captionStyles = StyleSheet.create({
  barWrap: {
    left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: 10, paddingHorizontal: 16,
  },
  barText: {
    color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center',
  },
  boldText: {
    fontSize: 34, fontWeight: '900', textAlign: 'center',
    // Centers the glyph in its box so it lands where it was dragged.
    lineHeight: 40, includeFontPadding: false, textAlignVertical: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
});

export function boldTextStyle(meta: Pick<CaptionMeta, 'font' | 'color'>) {
  return [
    captionStyles.boldText,
    { fontFamily: CAPTION_FONTS[meta.font ?? 0], color: meta.color ?? '#fff' },
  ];
}

/** The read-only caption, positioned within a `width` × `height` media area. */
export function CaptionView(
  { meta, text, width, height }: { meta: CaptionMeta; text: string; width: number; height: number },
) {
  if (!text) return null;

  if (meta.style === 'bar') {
    const barPos = { top: clamp01(meta.y) * height };
    return (
      <View
        pointerEvents="none"
        style={[captionStyles.barWrap, styles.barAbsolute, barPos]}
      >
        <Text style={captionStyles.barText}>{text}</Text>
      </View>
    );
  }

  const boldTransform = {
    transform: [
      { translateX: ((meta.x ?? 0.5) - 0.5) * width },
      { translateY: (clamp01(meta.y) - 0.5) * height },
      { rotate: `${meta.rot ?? 0}rad` },
      { scale: meta.scale ?? 1 },
    ],
  };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Text
        style={[
          boldTextStyle(meta),
          boldTransform,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  barAbsolute: { position: 'absolute' },
});
