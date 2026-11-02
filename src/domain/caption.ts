import { clamp } from '../utils/gesture';

/**
 * Pure domain types and parser for styled media captions.
 *
 * `CaptionMeta` is a discriminated union so `'bar'` captions cannot carry bold-only transform/font
 * fields and `'bold'` captions always carry concrete numbers and strings (never `undefined`).
 */

export const CAPTION_FONT_LABELS = ['Clean', 'Comic', 'Serif', 'Script', 'Mono'] as const;

export const CAPTION_COLORS = [
  '#ffffff', '#000000', '#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#af52de',
] as const;

export type CaptionStyle = 'bar' | 'bold';

export interface BarCaptionMeta {
  readonly style: 'bar';
  /** 0..1 from the top edge of the media area. */
  readonly y: number;
}

export interface BoldCaptionMeta {
  readonly style: 'bold';
  /** 0..1 horizontal center. */
  readonly x: number;
  /** 0..1 vertical center. */
  readonly y: number;
  /** Rotation in radians. */
  readonly rot: number;
  readonly scale: number;
  readonly color: string;
  /** Index into `CAPTION_FONT_LABELS`. */
  readonly font: number;
}

export type CaptionMeta = BarCaptionMeta | BoldCaptionMeta;

export const DEFAULT_BAR: BarCaptionMeta = { style: 'bar', y: 0.72 };

export const clamp01 = (v: number): number => clamp(v, 0, 1);

/**
 * Parse a serialized `CaptionMeta` JSON string into a normalized `BarCaptionMeta | BoldCaptionMeta`,
 * or `null` if missing/invalid.
 */
export function parseCaptionMeta(raw?: string | null): CaptionMeta | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.y !== 'number' || !Number.isFinite(m.y)) return null;
  const y = clamp01(m.y);

  if (m.style === 'bar') {
    return { style: 'bar', y };
  }
  if (m.style === 'bold') {
    const x = typeof m.x === 'number' && Number.isFinite(m.x) ? clamp01(m.x) : 0.5;
    const rot = typeof m.rot === 'number' && Number.isFinite(m.rot) ? m.rot : 0;
    const scale = typeof m.scale === 'number' && Number.isFinite(m.scale) && m.scale > 0 ? m.scale : 1;
    const color = typeof m.color === 'string' && m.color !== '' ? m.color : CAPTION_COLORS[0];
    const font = typeof m.font === 'number' && Number.isInteger(m.font) && m.font >= 0 && m.font < CAPTION_FONT_LABELS.length
      ? m.font
      : 0;
    return { style: 'bold', x, y, rot, scale, color, font };
  }
  return null;
}

export function serializeCaptionMeta(meta: CaptionMeta): string {
  return JSON.stringify(meta);
}
