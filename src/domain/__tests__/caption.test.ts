import {
  CAPTION_COLORS, CAPTION_FONT_LABELS, DEFAULT_BAR,
  buildCaptionMeta, parseCaptionMeta, serializeCaptionMeta,
} from '../caption';

describe('buildCaptionMeta', () => {
  it('returns null when caption text is empty or whitespace-only', () => {
    expect(buildCaptionMeta({ text: '', style: 'bar', y: 0.5 })).toBeNull();
    expect(buildCaptionMeta({ text: '   ', style: 'bold', y: 0.5 })).toBeNull();
  });

  it('builds a bar caption and clamps y to [0, 1]', () => {
    expect(buildCaptionMeta({ text: 'hello', style: 'bar', y: 0.72 })).toEqual({
      style: 'bar',
      y: 0.72,
    });
    expect(buildCaptionMeta({ text: 'hello', style: 'bar', y: -0.2 })).toEqual({
      style: 'bar',
      y: 0,
    });
    expect(buildCaptionMeta({ text: 'hello', style: 'bar', y: 1.4 })).toEqual({
      style: 'bar',
      y: 1,
    });
  });

  it('builds a bold caption with clamped coordinates, color lookup, and font index fallback', () => {
    expect(buildCaptionMeta({
      text: 'boom',
      style: 'bold',
      x: 0.25,
      y: 0.75,
      rot: 0.5,
      scale: 1.5,
      colorIdx: 2,
      fontIdx: 3,
    })).toEqual({
      style: 'bold',
      x: 0.25,
      y: 0.75,
      rot: 0.5,
      scale: 1.5,
      color: CAPTION_COLORS[2],
      font: 3,
    });

    expect(buildCaptionMeta({
      text: 'defaults and clamps',
      style: 'bold',
      x: 2,
      y: -1,
      scale: 0,
      colorIdx: 99,
      fontIdx: 99,
    })).toEqual({
      style: 'bold',
      x: 1,
      y: 0,
      rot: 0,
      scale: 1,
      color: CAPTION_COLORS[0],
      font: 0,
    });
  });
});

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
