import {
  approveLink,
  linkCodeDeviceName,
  loadDevices,
  primaryOnly,
  unlinkDevice,
} from '../devices';
import { confirm, confirmAndApproveLink } from '../../components/confirm';
import { subscribeToast, toast, type ToastItem } from '../toast';
import { resetSession, useStore } from '../store';
import { Obscura, type DeviceInfo } from '../../native/ObscuraModule';
import { FAKE_LINK_DEVICE_NAME } from '../../native/__fixtures__/FakeObscuraBridge';
import { Alert, getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const PRIMARY: DeviceInfo = {
  deviceId: 'device_self',
  name: 'Phone',
  isPrimary: true,
  isThisDevice: true,
};
const TABLET: DeviceInfo = {
  deviceId: 'device_tablet',
  name: 'Tablet',
  isPrimary: false,
  isThisDevice: false,
};

beforeEach(() => {
  resetSession();
  bridge.__authenticate();
  useStore.setState({ authed: true, isPrimary: true });
});

describe('loadDevices', () => {
  it('lists the primary first', async () => {
    bridge.__setDevices([TABLET, PRIMARY]);

    expect((await loadDevices()).map(d => d.deviceId)).toEqual(['device_self', 'device_tablet']);
  });
});

describe('linkCodeDeviceName', () => {
  it('reads the name of a trimmed or QR-prefixed link code through the kit', async () => {
    const code = await Obscura.beginLink('alice', 'password-1234');

    expect(await linkCodeDeviceName(` ${code}\n`)).toBe(FAKE_LINK_DEVICE_NAME);
    expect(await linkCodeDeviceName(`obscura:link:${code}`)).toBe(FAKE_LINK_DEVICE_NAME);
  });

  it('answers null for text that is not a link code', async () => {
    expect(await linkCodeDeviceName('hello')).toBeNull();
  });

  it('propagates other failures', async () => {
    bridge.__failNext('linkCodeDeviceName', 'STORAGE_ERROR');

    await expect(linkCodeDeviceName('link_1')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
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

    await expect(primaryOnly(() => Obscura.addFriendByCode('x'))).rejects.toMatchObject({
      code: 'INVALID_FRIEND_CODE',
    });

    expect(useStore.getState().isPrimary).toBe(true);
  });

  it('refuses friend changes on a linked device', async () => {
    bridge.__setPrimary(false);

    await expect(primaryOnly(() => Obscura.acceptFriend('u'))).rejects.toMatchObject({
      code: 'NOT_PRIMARY',
    });

    expect(useStore.getState().isPrimary).toBe(false);
  });
});

describe('unlinkDevice', () => {
  it('unlinks another device from the primary and stays signed in', async () => {
    bridge.__setDevices([PRIMARY, TABLET]);

    await unlinkDevice(TABLET);

    expect((await loadDevices()).map(d => d.deviceId)).toEqual(['device_self']);
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

    await expect(unlinkDevice({ ...PRIMARY, isPrimary: false })).rejects.toMatchObject({
      code: 'HTTP_ERROR',
    });

    expect(useStore.getState().authed).toBe(true);
  });

  it('refuses to unlink another device from a linked device', async () => {
    bridge.__setPrimary(false);

    await expect(unlinkDevice(TABLET)).rejects.toMatchObject({ code: 'NOT_PRIMARY' });

    expect(useStore.getState().isPrimary).toBe(false);
  });
});

describe('confirm & confirmAndApproveLink', () => {
  it('resolves confirm for cancel, action, destructive action, and dismiss', async () => {
    Alert.__enqueue((_t, _m, buttons) => buttons?.[0]?.onPress?.());
    await expect(confirm('Title', 'Body', 'Go')).resolves.toBe(false);

    Alert.__enqueue((_t, _m, buttons) => {
      expect(buttons?.[1]?.style).toBe('default');
      buttons?.[1]?.onPress?.();
    });
    await expect(confirm('Title', 'Body', 'Go')).resolves.toBe(true);

    Alert.__enqueue((_t, _m, buttons) => {
      expect(buttons?.[1]?.style).toBe('destructive');
      buttons?.[1]?.onPress?.();
    });
    await expect(confirm('Title', 'Body', 'Remove', true)).resolves.toBe(true);

    Alert.__enqueue((_t, _m, _buttons, opts) => opts?.onDismiss?.());
    await expect(confirm('Title', 'Body', 'Go')).resolves.toBe(false);
  });

  it('handles invalid codes, lookup errors, cancellation, approval success, and approval errors in confirmAndApproveLink', async () => {
    const toasts: ToastItem[] = [];
    const unsubscribe = subscribeToast(t => toasts.push(t));

    // 1. Invalid code -> toast.error
    await expect(confirmAndApproveLink('not-a-code')).resolves.toBe(false);
    expect(toasts[toasts.length - 1]).toMatchObject({
      type: 'error',
      message: 'That is not a device link code',
    });

    // 2. linkCodeDeviceName error -> toast.error
    bridge.__failNext('linkCodeDeviceName', 'STORAGE_ERROR', 'db broken');
    await expect(confirmAndApproveLink('link_1')).resolves.toBe(false);
    expect(toasts[toasts.length - 1]).toMatchObject({ type: 'error', message: 'db broken' });

    // 3. User cancels confirmation
    Alert.__enqueue((_t, _m, buttons) => buttons?.[0]?.onPress?.());
    await expect(confirmAndApproveLink('link_1')).resolves.toBe(false);
    expect(bridge.__approved).toEqual([]);

    // 4. User confirms and approveLink succeeds -> toast.success
    Alert.__enqueue((_t, _m, buttons) => buttons?.[1]?.onPress?.());
    await expect(confirmAndApproveLink('link_1')).resolves.toBe(true);
    expect(bridge.__approved).toEqual(['link_1']);
    expect(toasts[toasts.length - 1]).toMatchObject({
      type: 'success',
      message: `${FAKE_LINK_DEVICE_NAME} linked`,
    });

    // 5. User confirms and approveLink fails -> toast.error; empty toast messages are ignored
    Alert.__enqueue((_t, _m, buttons) => buttons?.[1]?.onPress?.());
    bridge.__failNext('approveLink', 'LINK_FAILED', 'expired');
    await expect(confirmAndApproveLink('link_2')).resolves.toBe(false);
    expect(toasts[toasts.length - 1]).toMatchObject({ type: 'error', message: 'expired' });
    const countBeforeEmpty = toasts.length;
    toast.error('');
    expect(toasts).toHaveLength(countBeforeEmpty);

    unsubscribe();
    unsubscribe();
    toast.success('unsubscribed');
    expect(toasts).toHaveLength(countBeforeEmpty);
  });
});
