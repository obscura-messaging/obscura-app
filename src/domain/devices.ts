/** A readable message for anything thrown. */
export function errorMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(e);
}

/** The `code` of a bridge rejection, if any. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** One device of the signed-in account. */
export interface DeviceInfo {
  deviceId: string;
  name: string | null;
  isPrimary: boolean;
  isThisDevice: boolean;
}

/** Primary first, then by name, so the list does not reorder between loads. */
export function orderDevices(devices: readonly DeviceInfo[]): DeviceInfo[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.isPrimary) - Number(a.isPrimary) ||
      deviceLabel(a).localeCompare(deviceLabel(b)) ||
      a.deviceId.localeCompare(b.deviceId),
  );
}

export function deviceLabel(device: Pick<DeviceInfo, 'name'>): string {
  return device.name || 'Unnamed device';
}

/** Why linking this device stopped. A cancelled link is not a problem to show. */
export type LinkProblem = { kind: 'expired' } | { kind: 'failed'; message: string };

export function linkProblem(e: unknown): LinkProblem | null {
  switch (errorCode(e)) {
    case 'CANCELLED':
      return null;
    case 'LINK_FAILED':
      return { kind: 'expired' };
    default:
      return { kind: 'failed', message: errorMessage(e) };
  }
}
