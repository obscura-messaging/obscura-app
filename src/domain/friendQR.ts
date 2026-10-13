/** A friend code in a QR, prefixed so the scanner ignores other QR codes. */
const PREFIX = 'obscura:friend:';

export function encodeFriendQR(code: string): string {
  return PREFIX + code;
}

/** The friend code in a scanned value, or null if it is not an Obscura friend QR. */
export function parseFriendQR(value: string | undefined): string | null {
  if (!value?.startsWith(PREFIX)) return null;
  const code = value.slice(PREFIX.length).trim();
  return code.length > 0 ? code : null;
}
