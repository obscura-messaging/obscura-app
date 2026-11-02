import {
  activityPreview, chatTimeline, conversationItems, friendActivities,
  pixBadgeFor, pixStatus, type ConversationItem, type DirectMessageItem, type PixItem,
} from '../chats';
import { friendProfileEntries, type Friend, type ProfileItem } from '../friends';
import { displayMs, storyGroups, type StoryItem } from '../viewer';
import { isBackSwipeGesture, shouldCompleteBackSwipe } from '../../utils/gesture';

const ME = 'uMe';
const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };
const DAVE: Friend = { userId: 'uDave', username: 'dave', status: 'pending_received' };

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
      contentKey: 'key',
      nonce: 'nonce',
      mediaType: 'photo',
    },
    caption,
    captionMeta: null,
    displayDuration: 5,
  };
}

function storyItem(id: string, sentAt: number, authorUserId: string, content = ''): StoryItem {
  return {
    id,
    authorUserId,
    sentAt,
    content,
    attachment: null,
    captionMeta: null,
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

describe('displayMs', () => {
  it('uses the default for no limit or no value', () => {
    expect(displayMs(3)).toBe(3_000);
    expect(displayMs(0)).toBe(5_000);
    expect(displayMs(undefined)).toBe(5_000);
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

describe('back swipe gesture helpers', () => {
  it('recognizes a deliberate horizontal right swipe and ignores vertical scrolling or left swipes', () => {
    expect(isBackSwipeGesture(24, 4)).toBe(true);
    expect(isBackSwipeGesture(10, 2)).toBe(false);
    expect(isBackSwipeGesture(-30, 2)).toBe(false);
    expect(isBackSwipeGesture(24, 15)).toBe(false);
  });

  it('completes a back swipe on sufficient distance or velocity', () => {
    expect(shouldCompleteBackSwipe(80, 0.1)).toBe(true);
    expect(shouldCompleteBackSwipe(40, 0.7)).toBe(true);
    expect(shouldCompleteBackSwipe(40, 0.2)).toBe(false);
    expect(shouldCompleteBackSwipe(20, 0.9)).toBe(false);
  });
});

describe('friendActivities', () => {
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
    // Even though the newest pix is `received_viewed`, older unopened pix take precedence in the badge.
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
  });
});

describe('storyGroups & friendProfileEntries', () => {
  const identity = { myUserId: ME, myUsername: 'me', friends: [BOB, CAROL, DAVE] };

  it('groups stories by author, mine apart, freshest friend first', () => {
    const stories = [
      storyItem('b1', 100, BOB.userId),
      storyItem('c1', 200, CAROL.userId),
      storyItem('b2', 300, BOB.userId),
      storyItem('m1', 50, ME),
    ];

    const { mine, others } = storyGroups(stories, identity);

    expect(mine).toMatchObject({ userId: ME, username: 'me' });
    expect(mine.stories.map((s) => s.id)).toEqual(['m1']);
    expect(others.map((g) => [g.username, g.stories.map((s) => s.id)])).toEqual([
      ['bob', ['b1', 'b2']], ['carol', ['c1']],
    ]);
  });

  it('hides authors who are not accepted friends', () => {
    const stories = [
      storyItem('d', 100, DAVE.userId),
      storyItem('s', 100, 'uStranger'),
    ];

    const { mine, others } = storyGroups(stories, identity);

    expect(mine.stories).toEqual([]);
    expect(others).toEqual([]);
  });

  it('projects friend profiles only for accepted friends, never self or strangers', () => {
    const profiles: ProfileItem[] = [
      { userId: ME, authorDeviceId: 'd', updatedAt: 1, displayName: 'Me', bio: '' },
      { userId: BOB.userId, authorDeviceId: 'd', updatedAt: 1, displayName: 'Bobby', bio: 'hi' },
      { userId: DAVE.userId, authorDeviceId: 'd', updatedAt: 1, displayName: 'Dave', bio: '' },
      { userId: 'uStranger', authorDeviceId: 'd', updatedAt: 1, displayName: 'Who', bio: '' },
    ];

    expect(friendProfileEntries(profiles, identity)).toEqual([
      { entry: profiles[1], name: 'bob' },
    ]);
  });
});
