import type { DeviceRole } from './session';

export interface Friend {
  userId: string;
  username: string;
  status: 'pending_sent' | 'pending_received' | 'accepted';
}

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

export interface ProfileItem {
  userId: string;
  authorDeviceId: string;
  updatedAt: number;
  displayName: string;
  bio: string;
}

export function friendProfileEntries<P extends { userId: string }>(
  profiles: readonly P[],
  identity: Identity,
): Array<{ entry: P; name: string }> {
  return profiles.flatMap((entry) => {
    const name = entry.userId === identity.myUserId ? null : displayNameFor(entry.userId, identity);
    return name === null ? [] : [{ entry, name }];
  });
}

export function pendingFriendSubtitle(friend: Pick<Friend, 'status'>, role: DeviceRole): string {
  if (friend.status !== 'pending_received') return 'Request sent';
  return role === 'linked' ? 'Wants to be friends · accept on your primary' : 'Wants to be friends';
}

export function removeFriendPrompt(friend: Pick<Friend, 'username' | 'status'>): {
  title: string;
  body: string;
  actionLabel: string;
} {
  switch (friend.status) {
    case 'pending_received':
      return {
        title: `Decline ${friend.username}?`,
        body: 'This pending friend request will be removed.',
        actionLabel: 'Decline',
      };
    case 'pending_sent':
      return {
        title: `Cancel request to ${friend.username}?`,
        body: 'This pending friend request will be removed.',
        actionLabel: 'Cancel Request',
      };
    case 'accepted':
      return {
        title: `Remove ${friend.username}?`,
        body: 'You will no longer be friends with this user.',
        actionLabel: 'Remove',
      };
  }
}

export function sendOutcomeToast(
  recipientCount: number,
  includeStory: boolean,
  undelivered: readonly string[],
): { kind: 'success' | 'error'; message: string } {
  if (undelivered.length > 0) {
    return { kind: 'error', message: `Not delivered to ${undelivered.join(', ')}` };
  }
  const suffix = recipientCount === 1 ? '' : 's';
  const storyPart = includeStory ? ' + story' : '';
  return { kind: 'success', message: `Sent to ${recipientCount} friend${suffix}${storyPart}` };
}

export function sendButtonLabel(selectedCount: number, includeStory: boolean, sending: boolean): string {
  if (sending) return 'Sending…';
  const total = selectedCount + (includeStory ? 1 : 0);
  return total === 0 ? 'Select recipients' : `Send to ${total}`;
}
