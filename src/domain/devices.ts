import type { DeviceInfo } from '../native/ObscuraModule';
import { errorCode, errorMessage } from '../utils/log';

/** Primary first, then by name, so the list does not reorder between loads. */
export function orderDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort((a, b) =>
    Number(b.isPrimary) - Number(a.isPrimary)
    || deviceLabel(a).localeCompare(deviceLabel(b))
    || a.deviceId.localeCompare(b.deviceId));
}

export function deviceLabel(device: Pick<DeviceInfo, 'name'>): string {
  return device.name || 'Unnamed device';
}

/** Why linking this device stopped. A cancelled link is not a problem to show. */
export type LinkProblem = { kind: 'expired' } | { kind: 'failed'; message: string };

export function linkProblem(e: unknown): LinkProblem | null {
  switch (errorCode(e)) {
    case 'CANCELLED': return null;
    case 'LINK_FAILED': return { kind: 'expired' };
    default: return { kind: 'failed', message: errorMessage(e) };
  }
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PUBLIC_KEY_LENGTH = 33;
const DJB_KEY_TYPE = 0x05;

/**
 * The device name in a link code (base64url of the kit's `LinkCode`: 1 session id, 2 ephemeral
 * public key, 3 device name), or null when the text is not a link code. Only for showing the name
 * before approval; the kit validates the code again in `approveLink`.
 */
export function linkCodeDeviceName(code: string): string | null {
  const bytes = base64UrlBytes(code.trim());
  const fields = bytes === null ? null : lengthDelimitedFields(bytes);
  if (fields === null) return null;
  const key = fields.get(2);
  if (!fields.get(1)?.length || key?.length !== PUBLIC_KEY_LENGTH || key[0] !== DJB_KEY_TYPE) return null;
  return utf8(fields.get(3) ?? new Uint8Array());
}

function base64UrlBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    buffer = buffer * 64 + BASE64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const low = 2 ** bits;
      out.push(Math.floor(buffer / low));
      buffer %= low;
    }
  }
  return Uint8Array.from(out);
}

/** The length-delimited fields of a protobuf message by field number; null when it is malformed. */
function lengthDelimitedFields(bytes: Uint8Array): Map<number, Uint8Array> | null {
  const fields = new Map<number, Uint8Array>();
  let i = 0;
  const varint = (): number | null => {
    let value = 0;
    for (let shift = 0; i < bytes.length && shift < 50; shift += 7) {
      const byte = bytes[i++];
      value += (byte % 0x80) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return null;
  };
  while (i < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    switch (tag % 8) {
      case 0:
        if (varint() === null) return null;
        break;
      case 1:
        i += 8;
        break;
      case 2: {
        const length = varint();
        if (length === null || i + length > bytes.length) return null;
        fields.set(Math.floor(tag / 8), bytes.subarray(i, i + length));
        i += length;
        break;
      }
      case 5:
        i += 4;
        break;
      default:
        return null;
    }
  }
  return i === bytes.length ? fields : null;
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return decodeURIComponent(Array.from(bytes, (b) => '%' + b.toString(16).padStart(2, '0')).join(''));
  } catch {
    return null;
  }
}
