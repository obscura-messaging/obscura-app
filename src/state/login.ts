import { Obscura } from '../native/ObscuraModule';
import { useStore } from './store';

export const MIN_PASSWORD_LENGTH = 12;

/** Why these credentials cannot be submitted, or `null` when they can. */
export function credentialsProblem(username: string, password: string): string | null {
  if (username === '') return 'Enter a username';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be ${MIN_PASSWORD_LENGTH}+ chars`;
  return null;
}

async function signIn(): Promise<void> {
  await Obscura.connect();
  useStore.setState({ authed: true });
}

export async function register(username: string, password: string): Promise<void> {
  await Obscura.registerUser(username, password);
  await signIn();
}

export type LogInResult = 'signedIn' | 'invalidCredentials' | 'linkRequired';

/**
 * Log in and connect an existing device. An unprovisioned phone needs to be linked by the
 * account's primary first (`linkRequired`).
 */
export async function logIn(username: string, password: string): Promise<LogInResult> {
  let scenario = await Obscura.login(username, password);
  if (scenario === 'deviceMismatch') {
    // The account no longer has this device (unlinked or reset), so start over as a fresh install.
    await Obscura.wipeDevice();
    scenario = await Obscura.login(username, password);
  }
  switch (scenario) {
    case 'invalidCredentials':
    case 'linkRequired':
      return scenario;
    case 'deviceMismatch':
      throw new Error('The server rejected this device after a wipe');
    case 'existingDevice':
      break;
  }
  await signIn();
  return 'signedIn';
}

let linkAttempt = 0;

/**
 * Link this phone to an account: `onCode` receives the code for the primary to scan, then this waits
 * for its approval. The kit provisions and connects; rejects `CANCELLED` after `cancelLink`.
 */
export async function linkThisDevice(
  username: string, password: string, onCode: (code: string) => void,
): Promise<void> {
  const attempt = ++linkAttempt;
  const code = await Obscura.beginLink(username, password);
  if (attempt !== linkAttempt) {
    // Cancelled while the session opened: drop the request the bridge now holds.
    await Obscura.cancelLink();
    throw Object.assign(new Error('Link cancelled'), { code: 'CANCELLED' });
  }
  onCode(code);
  await Obscura.completeLink();
  useStore.setState({ authed: true });
}

export function cancelLink(): Promise<void> {
  linkAttempt += 1;
  return Obscura.cancelLink();
}

/** For a lost primary: delete every device of the account and start over with this phone as primary. */
export async function resetAccount(username: string, password: string): Promise<void> {
  await Obscura.resetAccount(username, password);
  await signIn();
}
