import { encodeQR, parseQR } from '../qr';

describe('QR codes', () => {
  it('round-trips each kind and refuses the other', () => {
    expect(parseQR('link', encodeQR('link', 'abc'))).toBe('abc');
    expect(parseQR('friend', encodeQR('friend', 'abc'))).toBe('abc');
    expect(parseQR('friend', encodeQR('link', 'abc'))).toBeNull();
    expect(parseQR('link', 'abc')).toBeNull();
    expect(parseQR('link', encodeQR('link', ' '))).toBeNull();
  });
});
