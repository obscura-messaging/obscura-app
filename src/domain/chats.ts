import { conversationId } from './audience';
import type { ScreenEntry } from './expiry';
import type { Friend } from './friends';

type ConversationEntry = ScreenEntry<{ conversationId: string }>;

/** How a pix looks from this user's side of the conversation. */
export type PixStatus = 'received_new' | 'received_viewed' | 'sent_pending' | 'sent_opened';

export function pixStatus(pix: { authorUserId: string; viewedAt: number | null }, myUserId: string): PixStatus {
  const viewed = pix.viewedAt !== null;
  if (pix.authorUserId === myUserId) return viewed ? 'sent_opened' : 'sent_pending';
  return viewed ? 'received_viewed' : 'received_new';
}

export type ActivePixStatus = Exclude<PixStatus, 'received_viewed'>;

export type PixBadge =
  | { readonly kind: 'new'; readonly count: number }
  | { readonly kind: 'sent' }
  | { readonly kind: 'opened' }
  | null;

export type ChatTimelineItem<M extends ConversationEntry> =
  | (M & { readonly kind: 'message' })
  | {
      readonly kind: 'pix';
      readonly id: string;
      readonly sentAt: number;
      readonly authorUserId: string;
      readonly status: ActivePixStatus;
    };

/** Entries of one conversation, oldest first. */
export function conversationEntries<E extends ConversationEntry>(entries: readonly E[], convId: string): E[] {
  return entries.filter((e) => e.data.conversationId === convId).sort((a, b) => a.sentAt - b.sentAt);
}

/**
 * Chronological chat timeline for one conversation, oldest first.
 *
 * - Received pix that have been seen (`received_viewed`) are omitted so they never appear in chat.
 * - Pix timeline items carry only metadata (`id`, `sentAt`, `authorUserId`, `status`), never the
 *   viewer payload (`caption`, `mediaRef`, etc.), making caption leaks in chat impossible.
 */
export function chatTimeline<M extends ConversationEntry, P extends ConversationEntry>(
  messages: readonly M[],
  pix: readonly P[],
  convId: string,
  myUserId: string,
): ChatTimelineItem<M>[] {
  const msgItems: ChatTimelineItem<M>[] = conversationEntries(messages, convId).map((m) => ({
    ...m,
    kind: 'message' as const,
  }));
  const pixItems: ChatTimelineItem<M>[] = conversationEntries(pix, convId).flatMap((p) => {
    const status = pixStatus(p, myUserId);
    if (status === 'received_viewed') return [];
    return [{
      kind: 'pix' as const,
      id: p.id,
      sentAt: p.sentAt,
      authorUserId: p.authorUserId,
      status,
    }];
  });
  return [...msgItems, ...pixItems].sort((a, b) => a.sentAt - b.sentAt);
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
  /** Mutually-exclusive avatar badge state; `new` always takes precedence over older/newer viewed status. */
  badge: PixBadge;
}

export function pixBadgeFor(unopenedCount: number, latestPix: PixStatus | undefined): PixBadge {
  if (unopenedCount > 0) return { kind: 'new', count: unopenedCount };
  if (latestPix === 'sent_pending') return { kind: 'sent' };
  if (latestPix === 'received_viewed' || latestPix === 'sent_opened') return { kind: 'opened' };
  return null;
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
    const unopenedPix = conversationPix.filter((p) => pixStatus(p, myUserId) === 'received_new');
    const latestPix = latest && pixStatus(latest, myUserId);
    return {
      friend,
      lastMessage,
      unopenedPix,
      latestPix,
      latestAt: Math.max(lastMessage?.sentAt ?? 0, latest?.sentAt ?? 0),
      badge: pixBadgeFor(unopenedPix.length, latestPix),
    };
  }).sort((a, b) => b.latestAt - a.latestAt);
}

/** Subtitle and emphasis for a conversation row in the chat list. */
export function activityPreview(
  activity: FriendActivity<{ authorUserId: string; sentAt: number; data: Record<string, unknown> }, unknown>,
  myUserId: string,
): { text: string; highlight: boolean } {
  const unopened = activity.unopenedPix.length;
  if (unopened > 0) {
    return {
      text: unopened === 1 ? 'New pix · tap to view' : `${unopened} new pix · tap to view`,
      highlight: true,
    };
  }
  const msg = activity.lastMessage;
  const content = typeof msg?.data.content === 'string' ? msg.data.content : '';
  if (msg && msg.sentAt >= activity.latestAt && content !== '') {
    return {
      text: `${msg.authorUserId === myUserId ? 'You: ' : ''}${content}`,
      highlight: false,
    };
  }
  switch (activity.latestPix) {
    case 'sent_pending':
      return { text: 'Pix delivered', highlight: false };
    case 'sent_opened':
      return { text: 'Pix opened', highlight: false };
    case 'received_viewed':
      return { text: 'Pix viewed', highlight: false };
    default:
      if (content !== '') {
        return {
          text: `${msg!.authorUserId === myUserId ? 'You: ' : ''}${content}`,
          highlight: false,
        };
      }
      return { text: 'Tap to chat', highlight: false };
  }
}
