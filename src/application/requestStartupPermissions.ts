import { Platform } from 'react-native';
import type { CameraPermissionStatus } from 'react-native-vision-camera';
import { Obscura } from '../native/ObscuraModule';

/** Whether asking can still show a system prompt; Android allows re-asking after a denial. */
export function canPromptFor(status: CameraPermissionStatus): boolean {
  return status === 'not-determined' || (Platform.OS === 'android' && status === 'denied');
}

/** One prompt at a time: Android drops concurrent requests. */
export async function requestStartupPermissions(): Promise<void> {
  // Imported lazily so the store stays loadable without the camera module (in tests).
  const { Camera } = await import('react-native-vision-camera');
  if (canPromptFor(Camera.getCameraPermissionStatus())) await Camera.requestCameraPermission();
  if (canPromptFor(Camera.getMicrophonePermissionStatus())) await Camera.requestMicrophonePermission();
  await Obscura.requestPushPermission();
}
