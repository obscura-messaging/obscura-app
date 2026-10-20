import { storyExpiresAt } from './expiry';
import { displayNameFor, type Identity } from './friends';
import type { Entry } from './merge';

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
