import type { Friend } from '../native/ObscuraModule';
import { conversationId } from './conversation';
import { pixStatus, type PixStatus } from './pix';
import type { ScreenEntry } from './seen';

type ConversationEntry = ScreenEntry<{ conversationId: string }>;

/** Entries of one conversation, oldest first. */
export function conversationEntries<E extends ConversationEntry>(entries: readonly E[], convId: string): E[] {
  return entries.filter((e) => e.data.conversationId === convId).sort((a, b) => a.sentAt - b.sentAt);
}

export interface FriendActivity<M, P> {
  friend: Friend;
  lastMessage: M | undefined;
  /** Received pix not yet seen, oldest first. */
  unopenedPix: P[];
  /** The status of the newest pix either way, if any. */
  latestPix: PixStatus | undefined;
  /** When anything last happened in the conversation, or 0. */
  latestAt: number;
}

/** Each friend's conversation summary, most recently active first. */
export function friendActivities<M extends ConversationEntry, P extends ConversationEntry>(
  friends: readonly Friend[],
  myUserId: string,
  messages: readonly M[],
  pix: readonly P[],
): FriendActivity<M, P>[] {
  return friends.map((friend) => {
    const convId = conversationId(myUserId, friend.userId);
    const lastMessage = conversationEntries(messages, convId).at(-1);
    const conversationPix = conversationEntries(pix, convId);
    const latest = conversationPix.at(-1);
    return {
      friend,
      lastMessage,
      unopenedPix: conversationPix.filter((p) => pixStatus(p, myUserId) === 'received_new'),
      latestPix: latest && pixStatus(latest, myUserId),
      latestAt: Math.max(lastMessage?.sentAt ?? 0, latest?.sentAt ?? 0),
    };
  }).sort((a, b) => b.latestAt - a.latestAt);
}
