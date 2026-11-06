/**
 * Stories grouping, media attachment projection, and cursor state machine for the story and
 * view-once pix viewer.
 */

import type { CaptionMeta } from './caption';
import type { ConversationItem, PixItem } from './chats';
import { displayNameFor, type Friend, type Identity } from './friends';

export type MediaType = 'photo' | 'video';

export interface MediaAttachment {
  id: string;
  contentKey: string;
  nonce: string;
  mediaType: MediaType;
}

export interface StoryItem {
  id: string;
  authorUserId: string;
  sentAt: number;
  content: string;
  attachment: MediaAttachment | null;
  captionMeta: CaptionMeta | null;
}

export interface ViewerSlide {
  id: string;
  sentAt: number;
  text: string;
  captionMeta: CaptionMeta | null;
  attachment: MediaAttachment | null;
  displayDuration?: number;
}

/** Seconds a photo shows when the sender chose no limit (0) or nothing. */
export const DEFAULT_DISPLAY_SECONDS = 5;

export function displayMs(displayDuration: number | undefined): number {
  return (displayDuration || DEFAULT_DISPLAY_SECONDS) * 1000;
}

export function storyToSlide(story: StoryItem): ViewerSlide {
  return {
    id: story.id,
    sentAt: story.sentAt,
    text: story.content,
    captionMeta: story.captionMeta,
    attachment: story.attachment,
  };
}

export function pixToSlide(pix: PixItem): ViewerSlide {
  return {
    id: pix.id,
    sentAt: pix.sentAt,
    text: pix.caption ?? '',
    captionMeta: pix.captionMeta,
    attachment: pix.attachment,
    displayDuration: pix.displayDuration,
  };
}

export interface StoryGroup<E = StoryItem> {
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
export function storyGroups<E extends StoryItem = StoryItem>(
  stories: readonly E[],
  identity: Identity,
): { mine: StoryGroup<E>; others: StoryGroup<E>[] } {
  const ordered = [...stories].sort((a, b) => a.sentAt - b.sentAt);
  const groupOf = (userId: string, username: string): StoryGroup<E> =>
    ({ userId, username, stories: ordered.filter((s) => s.authorUserId === userId) });

  const authors = [...new Set(ordered.map((s) => s.authorUserId))].filter((id) => id !== identity.myUserId);
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

export function pixViewerGroups(
  allMessages: readonly ConversationItem[],
  userId: string,
  username: string,
  entryIds: readonly string[],
  friends: readonly Friend[],
): { groups: StoryGroup<ViewerSlide>[]; initialGroupIdx: number } {
  const wanted = new Set(entryIds);
  const stories = allMessages
    .filter((p): p is PixItem => p.kind === 'pix' && wanted.has(p.id))
    .sort((a, b) => a.sentAt - b.sentAt)
    .map(pixToSlide);
  const resolvedUsername = friends.find((f) => f.userId === userId)?.username ?? username;
  return {
    groups: stories.length > 0 ? [{ userId, username: resolvedUsername, stories }] : [],
    initialGroupIdx: 0,
  };
}

export function storyViewerGroups(
  allStories: readonly StoryItem[],
  identity: Identity,
  initialUserId: string,
): { groups: StoryGroup<ViewerSlide>[]; initialGroupIdx: number } {
  const { mine, others } = storyGroups(allStories, identity);
  const populated = [mine, ...others]
    .filter((g) => g.stories.length > 0)
    .map((g) => ({ ...g, stories: g.stories.map(storyToSlide) }));
  const idx = populated.findIndex((g) => g.userId === initialUserId);
  return { groups: populated, initialGroupIdx: Math.max(0, idx) };
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
  if (cursor.storyIdx >= currentGroupLen) {
    return { kind: 'close' };
  }

  if (action === 'advance') {
    if (cursor.storyIdx < currentGroupLen - 1) {
      return { kind: 'step', cursor: { groupIdx: cursor.groupIdx, storyIdx: cursor.storyIdx + 1 } };
    }
    if ((groupLengths[cursor.groupIdx + 1] ?? 0) > 0) {
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
  if ((groupLengths[cursor.groupIdx - 1] ?? 0) > 0) {
    return {
      kind: 'turnCube',
      cursor: { groupIdx: cursor.groupIdx - 1, storyIdx: 0 },
      direction: -1,
    };
  }
  return { kind: 'stay' };
}
