import {
  CAPTION_COLORS, CAPTION_FONT_LABELS, DEFAULT_BAR,
  parseCaptionMeta, serializeCaptionMeta,
} from '../caption';

describe('parseCaptionMeta', () => {
  it('round-trips a bar caption and clamps y to [0, 1]', () => {
    const raw = serializeCaptionMeta({ style: 'bar', y: 1.5 });
    expect(parseCaptionMeta(raw)).toEqual({ style: 'bar', y: 1 });
    expect(parseCaptionMeta(serializeCaptionMeta(DEFAULT_BAR))).toEqual(DEFAULT_BAR);
  });

  it('normalizes a bold caption and fills defaults for omitted optional wire fields', () => {
    expect(parseCaptionMeta(JSON.stringify({ style: 'bold', y: 0.4 }))).toEqual({
      style: 'bold',
      x: 0.5,
      y: 0.4,
      rot: 0,
      scale: 1,
      color: CAPTION_COLORS[0],
      font: 0,
    });

    const full = {
      style: 'bold' as const,
      x: 0.25,
      y: 0.75,
      rot: -0.5,
      scale: 1.8,
      color: '#ff2d55',
      font: CAPTION_FONT_LABELS.length - 1,
    };
    expect(parseCaptionMeta(serializeCaptionMeta(full))).toEqual(full);
  });

  it('clamps out-of-range coordinates and falls back on out-of-bounds font or non-positive scale', () => {
    expect(parseCaptionMeta(JSON.stringify({
      style: 'bold', x: -2, y: 3, scale: -1, font: 99, color: '',
    }))).toEqual({
      style: 'bold',
      x: 0,
      y: 1,
      rot: 0,
      scale: 1,
      color: CAPTION_COLORS[0],
      font: 0,
    });

    expect(parseCaptionMeta(JSON.stringify({
      style: 'bold', x: 'bad', y: 0.5, rot: 'bad', scale: 0, font: CAPTION_FONT_LABELS.length,
    }))).toEqual({
      style: 'bold',
      x: 0.5,
      y: 0.5,
      rot: 0,
      scale: 1,
      color: CAPTION_COLORS[0],
      font: 0,
    });

    expect(parseCaptionMeta('{"style":"bold","y":0.5,"x":1e309,"rot":1e309,"scale":1e309,"font":0}')).toEqual({
      style: 'bold',
      x: 0.5,
      y: 0.5,
      rot: 0,
      scale: 1,
      color: CAPTION_COLORS[0],
      font: 0,
    });
  });

  it('returns null on empty, malformed, or unknown style payloads', () => {
    expect(parseCaptionMeta(null)).toBeNull();
    expect(parseCaptionMeta('')).toBeNull();
    expect(parseCaptionMeta('null')).toBeNull();
    expect(parseCaptionMeta('123')).toBeNull();
    expect(parseCaptionMeta('not-json')).toBeNull();
    expect(parseCaptionMeta(JSON.stringify({ style: 'neon', y: 0.5 }))).toBeNull();
    expect(parseCaptionMeta(JSON.stringify({ style: 'bar', y: 'nope' }))).toBeNull();
    expect(parseCaptionMeta('{"style":"bar","y":1e309}')).toBeNull();
  });
});
