/** What a QR code carries: a friend code or a device-link code. */
export type QRKind = 'friend' | 'link';

/** Prefixes, so a scanner ignores other QR codes and codes meant for another scanner. */
const PREFIX: Record<QRKind, string> = {
  friend: 'obscura:friend:',
  link: 'obscura:link:',
};

export function encodeQR(kind: QRKind, code: string): string {
  return PREFIX[kind] + code;
}

/** The code in a scanned value, or null if it is not an Obscura QR of this kind. */
export function parseQR(kind: QRKind, value: string | undefined): string | null {
  if (!value?.startsWith(PREFIX[kind])) return null;
  const code = value.slice(PREFIX[kind].length).trim();
  return code.length > 0 ? code : null;
}

/** Trims pasted input and strips an `obscura:<kind>:` QR prefix if the user copied a scanned QR value. */
export function cleanCode(kind: QRKind, input: string): string {
  const trimmed = input.trim();
  return parseQR(kind, trimmed) ?? trimmed;
}
