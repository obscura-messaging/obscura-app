import {
  MIN_PASSWORD_LENGTH,
  cancelLink,
  cancelPendingLinkOnUnmount,
  credentialsProblem,
  linkThisDevice,
  logIn,
  register,
  resetAccount,
} from '../login';
import { resetSession } from '../store';
import { sessionStatus, signInAs } from './support';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

beforeEach(() => {
  resetSession();
});

describe('logIn', () => {
  it('connects an existing device without provisioning', async () => {
    expect(await logIn('alice', 'password-1234')).toBe('signedIn');

    expect(sessionStatus()).toBe('signedIn');
    expect(bridge.connectionState).toBe('connected');
  });

  it('asks for a link when there is no local device', async () => {
    bridge.__setLoginScenario('linkRequired');

    expect(await logIn('alice', 'password-1234')).toBe('linkRequired');

    expect(sessionStatus()).toBe('signedOut');
    expect(bridge.connectionState).toBe('disconnected');
  });

  it('wipes a device the account no longer has, then logs in again to link', async () => {
    bridge.__deliverMessage({ id: 'stale_dm', content: 'old' });
    bridge.__deliverStory({ id: 'stale_story', content: 'old' });
    bridge.__setLoginScenario('deviceMismatch', 'linkRequired');

    expect(await logIn('alice', 'password-1234')).toBe('linkRequired');

    expect(await Obscura.getMessages()).toEqual([]);
    expect(await Obscura.getStories()).toEqual([]);
    expect(bridge.authState).toBe('loggedOut');
  });

  it('refuses a second mismatch rather than wiping in a loop', async () => {
    bridge.__deliverMessage({ id: 'stale_dm', content: 'old' });
    bridge.__setLoginScenario('deviceMismatch');

    await expect(logIn('alice', 'password-1234')).rejects.toThrow(/after a wipe/);

    expect(await Obscura.getMessages()).toEqual([]);
    expect(sessionStatus()).toBe('signedOut');
  });

  it('does not log in again when the wipe fails', async () => {
    bridge.__deliverMessage({ id: 'keep_dm', content: 'still here' });
    bridge.__setLoginScenario('deviceMismatch');
    bridge.__failNext('wipeDevice', 'WIPE_ERROR');

    await expect(logIn('alice', 'password-1234')).rejects.toMatchObject({ code: 'WIPE_ERROR' });

    expect(await Obscura.getMessages()).toHaveLength(1);
    expect(sessionStatus()).toBe('signedOut');
  });

  it('reports rejected credentials without touching the device', async () => {
    bridge.__setLoginScenario('invalidCredentials');

    expect(await logIn('alice', 'password-1234')).toBe('invalidCredentials');

    expect(sessionStatus()).toBe('signedOut');
    expect(bridge.connectionState).toBe('disconnected');
  });
});

describe('linkThisDevice', () => {
  it('shows the code, then signs in once the primary approves', async () => {
    const codes: string[] = [];
    const linking = linkThisDevice('alice', 'password-1234', code => codes.push(code));
    await waitForCall('completeLink');

    expect(codes).toHaveLength(1);
    expect(sessionStatus()).toBe('signedOut');

    bridge.__approvePendingLink();
    await linking;

    expect(sessionStatus()).toBe('signedIn');
    expect(await bridge.isPrimary()).toBe(false);
  });

  it('rejects LINK_FAILED when the session expires, and can start over', async () => {
    const first = linkThisDevice('alice', 'password-1234', () => {});
    await waitForCall('completeLink');
    bridge.__expirePendingLink();
    await expect(first).rejects.toMatchObject({ code: 'LINK_FAILED' });

    const second = linkThisDevice('alice', 'password-1234', () => {});
    await waitForCall('completeLink', 2);
    bridge.__approvePendingLink();
    await second;

    expect(sessionStatus()).toBe('signedIn');
  });

  it('rejects CANCELLED when cancelled while waiting', async () => {
    const linking = linkThisDevice('alice', 'password-1234', () => {});
    await waitForCall('completeLink');

    await cancelLink();

    await expect(linking).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(sessionStatus()).toBe('signedOut');
  });

  it('does not wait for approval when cancelled while the session opens', async () => {
    const codes: string[] = [];
    const linking = linkThisDevice('alice', 'password-1234', code => codes.push(code));

    await cancelPendingLinkOnUnmount();

    await expect(linking).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(codes).toEqual([]);
    expect(bridge.__calls).toContain('beginLink');
    expect(bridge.__calls).toContain('cancelLink');
    expect(bridge.__calls).not.toContain('completeLink');

    bridge.__calls.length = 0;
    signInAs();
    await cancelPendingLinkOnUnmount();
    expect(bridge.__calls).not.toContain('cancelLink');
  });
});

describe('resetAccount', () => {
  it('resets and provisions this device as the new primary, then connects', async () => {
    await resetAccount('alice', 'password-1234');

    expect(sessionStatus()).toBe('signedIn');
    expect(bridge.connectionState).toBe('connected');
  });

  it('connects nothing when the reset fails', async () => {
    bridge.__failNext('resetAccount', 'HTTP_ERROR');

    await expect(resetAccount('alice', 'password-1234')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });

    expect(sessionStatus()).toBe('signedOut');
    expect(bridge.connectionState).toBe('disconnected');
  });
});

/** Let the flow under test reach its `count`th call to `method`. */
async function waitForCall(method: string, count = 1): Promise<void> {
  const maxTicks = 50;
  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (bridge.__calls.filter(call => call === method).length >= count) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  if (bridge.__calls.filter(call => call === method).length < count) {
    throw new Error(`Timed out waiting for ${method} (#${count})`);
  }
}

describe('register', () => {
  it('registers, connects and signs in', async () => {
    await register('alice', 'password-1234');

    expect(sessionStatus()).toBe('signedIn');
    expect(bridge.connectionState).toBe('connected');
  });
});

describe('credentialsProblem', () => {
  it('accepts a username with a long enough password', () => {
    expect(credentialsProblem('alice', 'x'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('rejects an empty username or a short password', () => {
    expect(credentialsProblem('', 'x'.repeat(MIN_PASSWORD_LENGTH))).not.toBeNull();
    expect(credentialsProblem('alice', 'x'.repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
  });
});
