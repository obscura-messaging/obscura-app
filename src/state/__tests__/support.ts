import type { DeviceRole, Me } from '../../domain/session';
import { useStore, type Friend } from '../store';

/** Put the store in a signed-in session without going through the kit. */
export function signInAs(me: Partial<Me> = {}, as: DeviceRole = 'primary', friends: Friend[] = []): void {
  useStore.setState({
    session: {
      status: 'signedIn',
      me: { userId: 'user_self', username: 'self', deviceId: 'device_self', ...me },
      role: as,
    },
    friends,
  });
}

export const sessionStatus = () => useStore.getState().session.status;

export function role(): DeviceRole | null {
  const { session } = useStore.getState();
  return session.status === 'signedIn' ? session.role : null;
}

export function myUserId(): string | null {
  const { session } = useStore.getState();
  return session.status === 'signedIn' ? session.me.userId : null;
}
