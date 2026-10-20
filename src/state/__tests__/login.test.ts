import { MIN_PASSWORD_LENGTH, credentialsProblem, logIn, register } from '../login';
import { resetSession, useStore } from '../store';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

beforeEach(() => {
  resetSession();
});

describe('logIn', () => {
  it('connects an existing device without provisioning', async () => {
    expect(await logIn('alice', 'password-1234')).toBe(true);

    expect(bridge.__calls).toEqual(['login', 'connect']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('provisions a new device, then connects', async () => {
    bridge.__setLoginScenario('newDevice');

    expect(await logIn('alice', 'password-1234')).toBe(true);

    expect(bridge.__calls).toEqual(['login', 'loginAndProvision', 'connect']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('wipes a device the server no longer knows, then provisions and connects', async () => {
    bridge.__setLoginScenario('deviceMismatch');

    expect(await logIn('alice', 'password-1234')).toBe(true);

    expect(bridge.__calls).toEqual(['login', 'wipeDevice', 'loginAndProvision', 'connect']);
    expect(bridge.authState).toBe('authenticated');
    expect(useStore.getState().authed).toBe(true);
  });

  it('does not provision when the wipe fails', async () => {
    bridge.__setLoginScenario('deviceMismatch');
    bridge.__failNext('wipeDevice', 'WIPE_ERROR');

    await expect(logIn('alice', 'password-1234')).rejects.toMatchObject({ code: 'WIPE_ERROR' });

    expect(bridge.__calls).toEqual(['login', 'wipeDevice']);
    expect(useStore.getState().authed).toBe(false);
  });

  it('reports rejected credentials without touching the device', async () => {
    bridge.__setLoginScenario('invalidCredentials');

    expect(await logIn('alice', 'password-1234')).toBe(false);

    expect(bridge.__calls).toEqual(['login']);
    expect(useStore.getState().authed).toBe(false);
  });
});

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
