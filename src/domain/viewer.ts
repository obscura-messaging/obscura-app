/**
 * Stories grouping, media attachment projection, and cursor state machine for the story and
 * view-once pix viewer.
 */

import { storyExpiresAt } from './expiry';
import { displayNameFor, type Identity } from './friends';
import type { Entry } from './merge';

/** Seconds a photo shows when the sender chose no limit (0) or nothing. */
export const DEFAULT_DISPLAY_SECONDS = 5;

export function displayMs(displayDuration: number | undefined): number {
  return (displayDuration || DEFAULT_DISPLAY_SECONDS) * 1000;
}

export interface Attachment {
  readonly mediaRef: string;
  readonly contentKey: string;
  readonly nonce: string;
}

export function attachmentOf(entry: { data: Record<string, unknown> } | undefined): Attachment | null {
  const mediaRef = entry?.data.mediaRef;
  const contentKey = entry?.data.contentKey;
  const nonce = entry?.data.nonce;
  if (typeof mediaRef !== 'string' || typeof contentKey !== 'string' || typeof nonce !== 'string') return null;
  return { mediaRef, contentKey, nonce };
}

export interface StoryGroup<E> {
  userId: string;
  /** From the friend graph, never a payload. */
  username: string;
  /** Oldest first. */
  stories: E[];
}

/**
 * Live stories grouped by authenticated author: mine, and those of accepted friends with the most
 * recently posting first. Stories from anyone else are hidden.
 */
export function storyGroups<E extends Entry>(
  stories: readonly E[],
  identity: Identity,
  now: number,
): { mine: StoryGroup<E>; others: StoryGroup<E>[] } {
  const live = stories
    .filter((s) => storyExpiresAt(s.sentAt) > now)
    .sort((a, b) => a.sentAt - b.sentAt);
  const groupOf = (userId: string, username: string): StoryGroup<E> =>
    ({ userId, username, stories: live.filter((s) => s.authorUserId === userId) });

  const authors = [...new Set(live.map((s) => s.authorUserId))].filter((id) => id !== identity.myUserId);
  const others = authors.flatMap((userId) => {
    const username = displayNameFor(userId, identity);
    return username === null ? [] : [groupOf(userId, username)];
  });
  const newest = (g: StoryGroup<E>) => g.stories[g.stories.length - 1].sentAt;
  return {
    mine: groupOf(identity.myUserId, identity.myUsername),
    others: others.sort((a, b) => newest(b) - newest(a)),
  };
}

export interface ViewerCursor {
  readonly groupIdx: number;
  readonly storyIdx: number;
}

export type ViewerStep =
  | { readonly kind: 'stay' }
  | { readonly kind: 'step'; readonly cursor: ViewerCursor }
  | { readonly kind: 'turnCube'; readonly cursor: ViewerCursor; readonly direction: 1 | -1 }
  | { readonly kind: 'close' };

/**
 * Compute the next transition for an `'advance'` or `'rewind'` action given the number of items
 * in each group. When `lockRewind` is true (view-once pix), backward navigation is a no-op.
 */
export function stepViewer(
  cursor: ViewerCursor,
  groupLengths: readonly number[],
  action: 'advance' | 'rewind',
  lockRewind = false,
): ViewerStep {
  const currentGroupLen = groupLengths[cursor.groupIdx] ?? 0;
  if (currentGroupLen === 0 || cursor.storyIdx >= currentGroupLen) {
    return { kind: 'close' };
  }

  if (action === 'advance') {
    if (cursor.storyIdx < currentGroupLen - 1) {
      return { kind: 'step', cursor: { groupIdx: cursor.groupIdx, storyIdx: cursor.storyIdx + 1 } };
    }
    if (cursor.groupIdx < groupLengths.length - 1 && (groupLengths[cursor.groupIdx + 1] ?? 0) > 0) {
      return {
        kind: 'turnCube',
        cursor: { groupIdx: cursor.groupIdx + 1, storyIdx: 0 },
        direction: 1,
      };
    }
    return { kind: 'close' };
  }

  if (lockRewind) {
    return { kind: 'stay' };
  }
  if (cursor.storyIdx > 0) {
    return { kind: 'step', cursor: { groupIdx: cursor.groupIdx, storyIdx: cursor.storyIdx - 1 } };
  }
  if (cursor.groupIdx > 0 && (groupLengths[cursor.groupIdx - 1] ?? 0) > 0) {
    return {
      kind: 'turnCube',
      cursor: { groupIdx: cursor.groupIdx - 1, storyIdx: 0 },
      direction: -1,
    };
  }
  return { kind: 'stay' };
}
