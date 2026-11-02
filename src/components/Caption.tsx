import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import {
  CAPTION_FONT_LABELS, CAPTION_COLORS, DEFAULT_BAR, clamp01,
  parseCaptionMeta, serializeCaptionMeta,
  type CaptionMeta, type CaptionStyle, type BoldCaptionMeta,
} from '../domain/caption';

export {
  CAPTION_FONT_LABELS, CAPTION_COLORS, DEFAULT_BAR,
  parseCaptionMeta, serializeCaptionMeta,
  type CaptionMeta, type CaptionStyle,
};

// The blob stores a font index, resolved here to the closest system font on each platform.
const FONT_DEFS = [
  { ios: 'System', android: 'sans-serif' },
  { ios: 'Chalkboard SE', android: 'casual' },
  { ios: 'Georgia', android: 'serif' },
  { ios: 'Snell Roundhand', android: 'cursive' },
  { ios: 'Menlo', android: 'monospace' },
];

export const CAPTION_FONTS = FONT_DEFS.map(
  (f) => Platform.select({ ios: f.ios, android: f.android, default: f.ios }) as string,
);

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

export function boldTextStyle(meta: Pick<BoldCaptionMeta, 'font' | 'color'>) {
  return [
    captionStyles.boldText,
    { fontFamily: CAPTION_FONTS[meta.font] ?? CAPTION_FONTS[0], color: meta.color },
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
      { translateX: (meta.x - 0.5) * width },
      { translateY: (clamp01(meta.y) - 0.5) * height },
      { rotate: `${meta.rot}rad` },
      { scale: meta.scale },
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
