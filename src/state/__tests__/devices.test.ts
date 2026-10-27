import { approveLink, loadDevices, primaryOnly, unlinkDevice } from '../devices';
import { resetSession, useStore } from '../store';
import { Obscura, type DeviceInfo } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const PRIMARY: DeviceInfo = { deviceId: 'device_self', name: 'Phone', isPrimary: true, isThisDevice: true };
const TABLET: DeviceInfo = { deviceId: 'device_tablet', name: 'Tablet', isPrimary: false, isThisDevice: false };

beforeEach(() => {
  resetSession();
  bridge.__authenticate();
  useStore.setState({ authed: true, isPrimary: true });
});

describe('loadDevices', () => {
  it('lists the primary first', async () => {
    bridge.__setDevices([TABLET, PRIMARY]);

    expect((await loadDevices()).map((d) => d.deviceId)).toEqual(['device_self', 'device_tablet']);
  });
});

describe('approveLink', () => {
  it('approves the trimmed code on the primary', async () => {
    await approveLink('  code_1\n');

    expect(bridge.__approved).toEqual(['code_1']);
  });

  it('marks the session not primary when the kit refuses', async () => {
    bridge.__setPrimary(false);

    await expect(approveLink('code_1')).rejects.toMatchObject({ code: 'NOT_PRIMARY' });

    expect(useStore.getState().isPrimary).toBe(false);
    expect(bridge.__approved).toEqual([]);
  });
});

describe('primaryOnly', () => {
  it('leaves the session alone on other failures', async () => {
    bridge.__failNext('addFriendByCode', 'INVALID_FRIEND_CODE');

    await expect(primaryOnly(() => Obscura.addFriendByCode('x'))).rejects.toMatchObject({ code: 'INVALID_FRIEND_CODE' });

    expect(useStore.getState().isPrimary).toBe(true);
  });

  it('refuses friend changes on a linked device', async () => {
    bridge.__setPrimary(false);

    await expect(primaryOnly(() => Obscura.acceptFriend('u'))).rejects.toMatchObject({ code: 'NOT_PRIMARY' });

    expect(useStore.getState().isPrimary).toBe(false);
  });
});

describe('unlinkDevice', () => {
  it('unlinks another device from the primary and stays signed in', async () => {
    bridge.__setDevices([PRIMARY, TABLET]);

    await unlinkDevice(TABLET);

    expect((await loadDevices()).map((d) => d.deviceId)).toEqual(['device_self']);
    expect(useStore.getState().authed).toBe(true);
  });

  it('signs a linked device out when it unlinks itself', async () => {
    bridge.__setPrimary(false);
    const self = { ...PRIMARY, isPrimary: false };

    await unlinkDevice(self);

    expect(bridge.authState).toBe('loggedOut');
    expect(useStore.getState().authed).toBe(false);
  });

  it('keeps the session when the unlink fails', async () => {
    bridge.__setPrimary(false);
    bridge.__failNext('unlinkDevice', 'HTTP_ERROR');

    await expect(unlinkDevice({ ...PRIMARY, isPrimary: false })).rejects.toMatchObject({ code: 'HTTP_ERROR' });

    expect(useStore.getState().authed).toBe(true);
  });

  it('refuses to unlink another device from a linked device', async () => {
    bridge.__setPrimary(false);

    await expect(unlinkDevice(TABLET)).rejects.toMatchObject({ code: 'NOT_PRIMARY' });

    expect(useStore.getState().isPrimary).toBe(false);
  });
});
