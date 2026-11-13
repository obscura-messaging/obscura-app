import { Alert } from 'react-native';
import { deviceLabel, errorMessage } from '../domain/devices';
import { approveLink, linkCodeDeviceName } from '../state/devices';
import { toast } from '../state/toast';

/** Ask before an action; resolves true only when the user picks `action`. */
export function confirm(
  title: string,
  message: string,
  action: string,
  destructive = false,
): Promise<boolean> {
  return new Promise(resolve => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: action,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Show the device named in a link code, and approve it once the user confirms. Resolves whether it linked. */
export async function confirmAndApproveLink(code: string): Promise<boolean> {
  let name: string | null;
  try {
    name = await linkCodeDeviceName(code);
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
  if (name === null) {
    toast.error('That is not a device link code');
    return false;
  }
  const label = deviceLabel({ name });
  const confirmed = await confirm(
    `Link “${label}”?`,
    'It gets your account, friends and message history, and can send and receive as you. Only link a device you own.',
    'Link',
  );
  if (!confirmed) return false;
  try {
    await approveLink(code);
    toast.success(`${label} linked`);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}
