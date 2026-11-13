/** The signed-in account and this device, as the kit reports them. */
export interface Me {
  userId: string;
  username: string;
  deviceId: string;
}

/**
 * Whether this device is the account's primary, which alone may approve links and change the
 * friend graph. `unknown` when the kit could not say; the UI offers neither primary nor
 * linked-device actions until it can.
 */
export type DeviceRole = 'primary' | 'linked' | 'unknown';

export interface SignedIn {
  status: 'signedIn';
  me: Me;
  role: DeviceRole;
}

/**
 * `booting` until the cold-start auth check settles, so a signed-in user never sees the auth
 * screen flash. A session is `signedIn` only once its identity has been read: there is no
 * signed-in state without a user.
 */
export type Session = { status: 'booting' } | { status: 'signedOut' } | SignedIn;

export function deviceRole(isPrimary: boolean | null): DeviceRole {
  if (isPrimary === null) return 'unknown';
  return isPrimary ? 'primary' : 'linked';
}

/** The identity the kit reported, or null when any part of it is missing. */
export function toMe(
  userId: string | null,
  username: string | null,
  deviceId: string | null,
): Me | null {
  return userId && username && deviceId ? { userId, username, deviceId } : null;
}
