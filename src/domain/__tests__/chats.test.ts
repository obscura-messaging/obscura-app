import {
  activityPreview, chatTimeline, conversationItems, friendActivities,
  pixBadgeFor, pixStatus, unseenVisibleMessageIds,
  type ConversationItem, type DirectMessageItem, type PixItem,
} from '../chats';
import type { Friend } from '../friends';

const ME = 'uMe';
const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };

function msg(
  id: string,
  sentAt: number,
  authorUserId: string,
  peerUserId: string,
  content = '',
  viewedAt: number | null = null,
): DirectMessageItem {
  return {
    kind: 'message',
    id,
    peerUserId,
    authorUserId,
    sentAt,
    viewedAt,
    content,
  };
}

function pixItem(
  id: string,
  sentAt: number,
  authorUserId: string,
  peerUserId: string,
  viewedAt: number | null = null,
  caption: string | null = null,
): PixItem {
  return {
    kind: 'pix',
    id,
    peerUserId,
    authorUserId,
    sentAt,
    viewedAt,
    attachment: {
      id: 'att_1',
      mediaType: 'photo',
    },
    caption,
    captionMeta: null,
    displayDuration: 5,
  };
}

describe('pixStatus', () => {
  it('reads direction from the author and state from viewedAt', () => {
    expect(pixStatus({ authorUserId: ME, viewedAt: null }, ME)).toBe('sent_pending');
    expect(pixStatus({ authorUserId: ME, viewedAt: 1 }, ME)).toBe('sent_opened');
    expect(pixStatus({ authorUserId: 'x', viewedAt: null }, ME)).toBe('received_new');
    expect(pixStatus({ authorUserId: 'x', viewedAt: 1 }, ME)).toBe('received_viewed');
  });
});

describe('conversationItems', () => {
  it('keeps one peer conversation, oldest first', () => {
    const other = msg('o', 1, ME, CAROL.userId);
    const b = msg('b', 2, ME, BOB.userId);
    const a = msg('a', 1, ME, BOB.userId);

    expect(conversationItems([b, other, a], BOB.userId).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('chatTimeline', () => {
  it('orders messages and active pix chronologically and hides received_viewed pix', () => {
    const items: ConversationItem[] = [
      msg('m1', 10, BOB.userId, BOB.userId, 'hi'),
      msg('m2', 40, ME, BOB.userId, 'yo'),
      pixItem('p_viewed', 15, BOB.userId, BOB.userId, 16, 'secret'),
      pixItem('p_new', 20, BOB.userId, BOB.userId, null, 'do not leak'),
      pixItem('p_sent_pending', 25, ME, BOB.userId, null, 'mine'),
      pixItem('p_sent_opened', 30, ME, BOB.userId, 35, 'opened'),
    ];

    const timeline = chatTimeline(items, BOB.userId, ME);

    expect(timeline.map((item) => [item.kind, item.id])).toEqual([
      ['message', 'm1'],
      ['pix', 'p_new'],
      ['pix', 'p_sent_pending'],
      ['pix', 'p_sent_opened'],
      ['message', 'm2'],
    ]);
  });

  it('omits captions and media fields from pix timeline items so captions cannot leak in chat', () => {
    const items: ConversationItem[] = [
      pixItem('p_new', 20, BOB.userId, BOB.userId, null, 'hidden until opened'),
    ];

    const [item] = chatTimeline(items, BOB.userId, ME);

    expect(item).toEqual({
      kind: 'pix',
      id: 'p_new',
      sentAt: 20,
      authorUserId: BOB.userId,
      status: 'received_new',
    });
    expect('caption' in item).toBe(false);
    expect('attachment' in item).toBe(false);
  });
});

describe('friendActivities & activityPreview', () => {
  it('summarizes each conversation and orders by latest activity', () => {
    const items: ConversationItem[] = [
      msg('m1', 10, BOB.userId, BOB.userId, 'hey'),
      msg('m2', 20, ME, BOB.userId, 'yo'),
      pixItem('p1', 5, BOB.userId, BOB.userId),
      pixItem('p2', 30, BOB.userId, BOB.userId, 31),
      pixItem('p3', 6, BOB.userId, BOB.userId),
    ];

    const [bob, carol] = friendActivities([CAROL, BOB], ME, items);

    expect(bob.friend).toBe(BOB);
    expect(bob.lastMessage?.id).toBe('m2');
    expect(bob.unopenedPix.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(bob.latestPix).toBe('received_viewed');
    expect(bob.latestAt).toBe(30);
    expect(bob.badge).toEqual({ kind: 'new', count: 2 });
    expect(carol).toEqual({
      friend: CAROL,
      lastMessage: undefined,
      unopenedPix: [],
      latestPix: undefined,
      latestAt: 0,
      badge: null,
    });
  });

  it('computes activityPreview and badge from unopened pix, latest message, or latest pix status', () => {
    const [unopenedActivity] = friendActivities(
      [BOB],
      ME,
      [pixItem('p1', 10, BOB.userId, BOB.userId), pixItem('p2', 20, BOB.userId, BOB.userId)],
    );
    expect(activityPreview(unopenedActivity, ME)).toEqual({ text: '2 new pix · tap to view', highlight: true });
    expect(unopenedActivity.badge).toEqual({ kind: 'new', count: 2 });

    const [sentPixActivity] = friendActivities([BOB], ME, [pixItem('p3', 30, ME, BOB.userId)]);
    expect(activityPreview(sentPixActivity, ME)).toEqual({ text: 'Pix delivered', highlight: false });
    expect(sentPixActivity.badge).toEqual({ kind: 'sent' });

    const [msgActivity] = friendActivities(
      [BOB],
      ME,
      [msg('m1', 40, ME, BOB.userId, 'yo'), pixItem('p3', 30, ME, BOB.userId)],
    );
    expect(activityPreview(msgActivity, ME)).toEqual({ text: 'You: yo', highlight: false });
    expect(pixBadgeFor(0, 'sent_opened')).toEqual({ kind: 'opened' });

    const [emptyActivity] = friendActivities([BOB], ME, []);
    expect(activityPreview(emptyActivity, ME)).toEqual({ text: 'Tap to chat', highlight: false });

    const [msgOnlyActivity] = friendActivities([BOB], ME, [msg('m2', 10, BOB.userId, BOB.userId, 'hey there')]);
    expect(activityPreview(msgOnlyActivity, ME)).toEqual({
      text: 'hey there',
      highlight: false,
    });
    expect(activityPreview({ ...msgOnlyActivity, latestAt: 99 }, ME)).toEqual({
      text: 'hey there',
      highlight: false,
    });

    const [ownMsgOnlyActivity] = friendActivities([BOB], ME, [msg('m2_own', 10, ME, BOB.userId, 'from me')]);
    expect(activityPreview({ ...ownMsgOnlyActivity, latestAt: 99 }, ME)).toEqual({
      text: 'You: from me',
      highlight: false,
    });

    const [blankMsgActivity] = friendActivities([BOB], ME, [msg('m3', 10, BOB.userId, BOB.userId, '')]);
    expect(activityPreview(blankMsgActivity, ME)).toEqual({
      text: 'Tap to chat',
      highlight: false,
    });
  });
});

describe('unseenVisibleMessageIds', () => {
  it('returns only visible, unviewed incoming messages that are not already marked in flight', () => {
    const items: ConversationItem[] = [
      msg('m_visible_unseen', 10, BOB.userId, BOB.userId, 'read me', null),
      msg('m_own', 20, ME, BOB.userId, 'my own', null),
      msg('m_already_viewed', 30, BOB.userId, BOB.userId, 'seen', 35),
      msg('m_offscreen', 40, BOB.userId, BOB.userId, 'below fold', null),
      msg('m_in_flight', 50, BOB.userId, BOB.userId, 'marking', null),
      pixItem('p_visible', 60, BOB.userId, BOB.userId, null, 'pix'),
    ];
    const visible = new Set(['m_visible_unseen', 'm_own', 'm_already_viewed', 'm_in_flight', 'p_visible']);
    const marked = new Set(['m_in_flight']);

    expect(unseenVisibleMessageIds(items, visible, ME, marked)).toEqual(['m_visible_unseen']);
    expect(unseenVisibleMessageIds(items, visible, ME)).toEqual(['m_visible_unseen', 'm_in_flight']);
  });
});
