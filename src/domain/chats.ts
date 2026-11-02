import type { Friend } from './friends';

export interface ConversationItem {
  id: string;
  peerUserId: string;
  kind: 'message' | 'pix';
  authorUserId: string;
  sentAt: number;
  viewedAt: number | null;
  content: string;
  mediaRef: string | null;
  contentKey: string | null;
  nonce: string | null;
  mediaType: string | null;
  caption: string | null;
  captionMeta: string | null;
  displayDuration: number;
}

/** Canonical two-party conversation id: both user ids, sorted, joined by `_`. */
export function conversationId(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join('_');
}

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

export type ChatTimelineItem =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly sentAt: number;
      readonly authorUserId: string;
      readonly content: string;
    }
  | {
      readonly kind: 'pix';
      readonly id: string;
      readonly sentAt: number;
      readonly authorUserId: string;
      readonly status: ActivePixStatus;
    };

/** Items of one peer conversation, oldest first. */
export function conversationItems<T extends { peerUserId: string; sentAt: number }>(
  items: readonly T[],
  friendUserId: string,
): T[] {
  return items.filter((item) => item.peerUserId === friendUserId).sort((a, b) => a.sentAt - b.sentAt);
}

/**
 * Chronological chat timeline for one conversation, oldest first.
 *
 * - Received pix that have been seen (`received_viewed`) are omitted so they never appear in chat.
 * - Pix timeline items carry only metadata (`id`, `sentAt`, `authorUserId`, `status`), never the
 *   viewer payload (`caption`, `mediaRef`, etc.), making caption leaks in chat impossible.
 */
export function chatTimeline(
  items: readonly ConversationItem[],
  friendUserId: string,
  myUserId: string,
): ChatTimelineItem[] {
  return conversationItems(items, friendUserId).flatMap((item): ChatTimelineItem[] => {
    if (item.kind === 'message') {
      return [{
        kind: 'message',
        id: item.id,
        sentAt: item.sentAt,
        authorUserId: item.authorUserId,
        content: item.content,
      }];
    }
    const status = pixStatus(item, myUserId);
    if (status === 'received_viewed') return [];
    return [{
      kind: 'pix',
      id: item.id,
      sentAt: item.sentAt,
      authorUserId: item.authorUserId,
      status,
    }];
  });
}

export interface FriendActivity {
  friend: Friend;
  lastMessage: ConversationItem | undefined;
  /** Received pix not yet seen, oldest first. */
  unopenedPix: ConversationItem[];
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
export function friendActivities(
  friends: readonly Friend[],
  myUserId: string,
  items: readonly ConversationItem[],
): FriendActivity[] {
  return friends.map((friend) => {
    const peerItems = conversationItems(items, friend.userId);
    const messages = peerItems.filter((item) => item.kind === 'message');
    const pix = peerItems.filter((item) => item.kind === 'pix');
    const lastMessage = messages.at(-1);
    const latest = pix.at(-1);
    const unopenedPix = pix.filter((p) => pixStatus(p, myUserId) === 'received_new');
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
  activity: FriendActivity,
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
  const content = msg?.content ?? '';
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
      if (msg && content !== '') {
        return {
          text: `${msg.authorUserId === myUserId ? 'You: ' : ''}${content}`,
          highlight: false,
        };
      }
      return { text: 'Tap to chat', highlight: false };
  }
}
