/**
 * Display names for transport-attributed userIds, resolved through the local friend graph at render
 * time so a username change relabels everywhere.
 */

import type { Friend } from '../native/ObscuraModule';

export interface Identity {
  myUserId: string;
  myUsername: string;
  friends: readonly Friend[];
}

/**
 * The display name for `userId`, or `null` when the user is neither me nor an accepted friend.
 * Callers filter such content out rather than labelling it "unknown".
 */
export function displayNameFor(userId: string, id: Identity): string | null {
  if (userId === '') return null;
  if (userId === id.myUserId) return id.myUsername;
  return id.friends.find((f) => f.userId === userId && f.status === 'accepted')?.username ?? null;
}
