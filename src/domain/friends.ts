import type { Friend } from '../native/ObscuraModule';

export function isAccepted(friend: Friend): boolean {
  return friend.status === 'accepted';
}

export function acceptedFriends(friends: readonly Friend[]): Friend[] {
  return friends.filter(isAccepted);
}

export function pendingFriends(friends: readonly Friend[]): Friend[] {
  return friends.filter((f) => !isAccepted(f));
}

export interface Identity {
  myUserId: string;
  myUsername: string;
  /** Every relationship, any status. */
  friends: readonly Friend[];
}

/**
 * The name to show for a transport-attributed user, or `null` when they are neither me nor an
 * accepted friend; callers hide such content rather than label it "unknown".
 */
export function displayNameFor(userId: string, { myUserId, myUsername, friends }: Identity): string | null {
  if (userId === '') return null;
  if (userId === myUserId) return myUsername;
  return friends.find((f) => f.userId === userId && isAccepted(f))?.username ?? null;
}
