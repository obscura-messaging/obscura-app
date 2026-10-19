import { Obscura } from '../native/ObscuraModule';
import { useStore } from './store';

export const MIN_PASSWORD_LENGTH = 12;

/** Why these credentials cannot be submitted, or `null` when they can. */
export function credentialsProblem(username: string, password: string): string | null {
  if (username === '') return 'Enter a username';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be ${MIN_PASSWORD_LENGTH}+ chars`;
  return null;
}

export async function register(username: string, password: string): Promise<void> {
  await Obscura.registerUser(username, password);
  await Obscura.connect();
  useStore.setState({ authed: true });
}

/**
 * Log in and connect, provisioning this phone as a device when the server has none for it.
 * Resolves `false` when the server rejected the credentials.
 */
export async function logIn(username: string, password: string): Promise<boolean> {
  const scenario = await Obscura.login(username, password);
  switch (scenario) {
    case 'invalidCredentials':
      return false;
    case 'deviceMismatch':
      // The server no longer knows this device, so start over as a fresh install.
      await Obscura.wipeDevice();
      await Obscura.loginAndProvision(username, password);
      break;
    case 'newDevice':
      await Obscura.loginAndProvision(username, password);
      break;
    case 'existingDevice':
      break;
  }
  await Obscura.connect();
  useStore.setState({ authed: true });
  return true;
}
