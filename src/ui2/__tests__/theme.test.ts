import { DARK_OVERLAY, mixHex, resolveTheme, withAlpha } from '../theme';

describe('resolveTheme', () => {
  it('Sunny light', () => {
    const t = resolveTheme('Sunny', 'light');
    expect(t.yellow).toBe('#FFD21A');
    expect(t.blue).toBe('#62C6F3');
    expect(t.bar).toBe('#23272F');
  });

  it('Sunny dark', () => {
    const t = resolveTheme('Sunny', 'dark');
    expect(t.white).toBe('#283346');
    expect(t.black).toBe('#FFFFFF');
    expect(t.bar).toBe('#121418');
    expect(t.onSecondary.white).toBe('#FFFFFF');
    expect(t.onSecondary.black).toBe('#262A34');
  });

  it('Bubblegum dark primary', () => {
    const t = resolveTheme('Bubblegum', 'dark');
    expect(t.yellow).toBe('#CDFF80');
    expect(t.onSecondary.yellow).toBe('#DBFA75');
  });

  it('derives cream as color-mix(white 93%, yellow)', () => {
    expect(resolveTheme('Sunny', 'light').cream).toBe('#FFFCEF');
  });
});

describe('color helpers', () => {
  it('mixHex', () => {
    expect(mixHex('#000000', 50, '#FFFFFF')).toBe('#808080');
  });

  it('withAlpha', () => {
    const { color, alpha } = DARK_OVERLAY.messageOutline;
    // claude: 28% of 255 = 71 = 0x47
    expect(withAlpha(color, alpha)).toBe('#00000047');
  });
});
