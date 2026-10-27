import { Obscura, type DeviceInfo } from '../native/ObscuraModule';
import { orderDevices } from '../domain/devices';
import { errorCode } from '../utils/log';
import { resetSession, useStore } from './store';

/** Run an action only the primary may take. `NOT_PRIMARY` means the session was wrong, so correct it. */
export async function primaryOnly<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (errorCode(e) === 'NOT_PRIMARY') useStore.setState({ isPrimary: false });
    throw e;
  }
}

export async function loadDevices(): Promise<DeviceInfo[]> {
  return orderDevices(await Obscura.getDevices());
}

export function approveLink(code: string): Promise<void> {
  return primaryOnly(() => Obscura.approveLink(code.trim()));
}

/** Unlinking this device wipes it and signs out; only the primary unlinks another device. */
export async function unlinkDevice(device: DeviceInfo): Promise<void> {
  if (!device.isThisDevice) {
    await primaryOnly(() => Obscura.unlinkDevice(device.deviceId));
    return;
  }
  await Obscura.unlinkDevice(device.deviceId);
  resetSession();
}
