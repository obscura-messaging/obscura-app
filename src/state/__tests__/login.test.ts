import {
  MIN_PASSWORD_LENGTH, cancelLink, credentialsProblem, linkThisDevice, logIn, register, resetAccount,
} from '../login';
import { resetSession, useStore } from '../store';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

beforeEach(() => {
  resetSession();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('logIn', () => {
  it('connects an existing device without provisioning', async () => {
    expect(await logIn('alice', 'password-1234')).toBe('signedIn');

    expect(bridge.__calls).toEqual(['login', 'connect']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('provisions the primary of an account without devices, then connects', async () => {
    bridge.__setLoginScenario('noDevices');

    expect(await logIn('alice', 'password-1234')).toBe('signedIn');

    expect(bridge.__calls).toEqual(['login', 'provisionPrimary', 'connect']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('asks for a link when the account already has devices', async () => {
    bridge.__setLoginScenario('linkRequired');

    expect(await logIn('alice', 'password-1234')).toBe('linkRequired');

    expect(bridge.__calls).toEqual(['login']);
    expect(useStore.getState().authed).toBe(false);
  });

  it('wipes a device the account no longer has, then logs in again', async () => {
    bridge.__setLoginScenario('deviceMismatch');
    const login = bridge.login.bind(bridge);
    jest.spyOn(bridge, 'login').mockImplementation(async (u, p) => {
      const scenario = await login(u, p);
      bridge.__setLoginScenario('noDevices');
      return scenario;
    });

    expect(await logIn('alice', 'password-1234')).toBe('signedIn');

    expect(bridge.__calls).toEqual(['login', 'wipeDevice', 'login', 'provisionPrimary', 'connect']);
    expect(bridge.authState).toBe('authenticated');
  });

  it('refuses a second mismatch rather than wiping in a loop', async () => {
    bridge.__setLoginScenario('deviceMismatch');

    await expect(logIn('alice', 'password-1234')).rejects.toThrow(/after a wipe/);

    expect(bridge.__calls).toEqual(['login', 'wipeDevice', 'login']);
  });

  it('does not log in again when the wipe fails', async () => {
    bridge.__setLoginScenario('deviceMismatch');
    bridge.__failNext('wipeDevice', 'WIPE_ERROR');

    await expect(logIn('alice', 'password-1234')).rejects.toMatchObject({ code: 'WIPE_ERROR' });

    expect(bridge.__calls).toEqual(['login', 'wipeDevice']);
    expect(useStore.getState().authed).toBe(false);
  });

  it('reports rejected credentials without touching the device', async () => {
    bridge.__setLoginScenario('invalidCredentials');

    expect(await logIn('alice', 'password-1234')).toBe('invalidCredentials');

    expect(bridge.__calls).toEqual(['login']);
    expect(useStore.getState().authed).toBe(false);
  });
});

describe('linkThisDevice', () => {
  it('shows the code, then signs in once the primary approves', async () => {
    const codes: string[] = [];
    const linking = linkThisDevice('alice', 'password-1234', (code) => codes.push(code));
    await waitForCall('completeLink');

    expect(codes).toHaveLength(1);
    expect(useStore.getState().authed).toBe(false);

    bridge.__approvePendingLink();
    await linking;

    expect(useStore.getState().authed).toBe(true);
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

    expect(useStore.getState().authed).toBe(true);
  });

  it('rejects CANCELLED when cancelled while waiting', async () => {
    const linking = linkThisDevice('alice', 'password-1234', () => {});
    await waitForCall('completeLink');

    await cancelLink();

    await expect(linking).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(useStore.getState().authed).toBe(false);
  });

  it('does not wait for approval when cancelled while the session opens', async () => {
    const codes: string[] = [];
    const linking = linkThisDevice('alice', 'password-1234', (code) => codes.push(code));

    await cancelLink();

    await expect(linking).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(codes).toEqual([]);
    expect(bridge.__calls).toEqual(['beginLink', 'cancelLink', 'cancelLink']);
  });
});

describe('resetAccount', () => {
  it('resets, provisions this device as the new primary and connects', async () => {
    await resetAccount('alice', 'password-1234');

    expect(bridge.__calls).toEqual(['resetAccount', 'provisionPrimary', 'connect']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('provisions nothing when the reset fails', async () => {
    bridge.__failNext('resetAccount', 'HTTP_ERROR');

    await expect(resetAccount('alice', 'password-1234')).rejects.toMatchObject({ code: 'HTTP_ERROR' });

    expect(bridge.__calls).toEqual(['resetAccount']);
  });
});

/** Let the flow under test reach its `count`th call to `method`. */
async function waitForCall(method: string, count = 1): Promise<void> {
  while (bridge.__calls.filter((call) => call === method).length < count) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('register', () => {
  it('registers, connects and signs in', async () => {
    await register('alice', 'password-1234');

    expect(bridge.__calls).toEqual(['registerUser', 'connect']);
    expect(useStore.getState().authed).toBe(true);
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
