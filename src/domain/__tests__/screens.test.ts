import { conversationId } from '../audience';
import {
  activityPreview, chatTimeline, friendActivities, conversationEntries,
  pixBadgeFor, pixStatus,
} from '../chats';
import { STORY_MAX_AGE_MS, type ScreenEntry } from '../expiry';
import type { Friend } from '../friends';
import { displayMs, storyGroups } from '../viewer';
import { isBackSwipeGesture, shouldCompleteBackSwipe } from '../../utils/gesture';

const ME = 'uMe';
const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };
const DAVE: Friend = { userId: 'uDave', username: 'dave', status: 'pending_received' };

function entry(id: string, sentAt: number, authorUserId: string, data: Record<string, unknown> = {}, viewedAt: number | null = null):
  ScreenEntry<{ conversationId: string; [key: string]: unknown }> {
  return { id, sentAt, authorUserId, authorDeviceId: 'd', viewedAt, data: { conversationId: '', ...data } };
}
const withBob = (id: string, sentAt: number, author: string, viewedAt: number | null = null) =>
  entry(id, sentAt, author, { conversationId: conversationId(ME, BOB.userId) }, viewedAt);

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

describe('conversationEntries', () => {
  it('keeps one conversation, oldest first', () => {
    const other = entry('o', 1, ME, { conversationId: conversationId(ME, CAROL.userId) });

    expect(conversationEntries([withBob('b', 2, ME), other, withBob('a', 1, ME)], conversationId(ME, BOB.userId))
      .map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('chatTimeline', () => {
  const convId = conversationId(ME, BOB.userId);

  it('orders messages and active pix chronologically and hides received_viewed pix', () => {
    const messages = [
      entry('m1', 10, BOB.userId, { conversationId: convId, content: 'hi' }),
      entry('m2', 40, ME, { conversationId: convId, content: 'yo' }),
    ];
    const pix = [
      entry('p_viewed', 15, BOB.userId, { conversationId: convId, caption: 'secret' }, 16),
      entry('p_new', 20, BOB.userId, { conversationId: convId, caption: 'do not leak' }, null),
      entry('p_sent_pending', 25, ME, { conversationId: convId, caption: 'mine' }, null),
      entry('p_sent_opened', 30, ME, { conversationId: convId, caption: 'opened' }, 35),
    ];

    const timeline = chatTimeline(messages, pix, convId, ME);

    expect(timeline.map((item) => [item.kind, item.id])).toEqual([
      ['message', 'm1'],
      ['pix', 'p_new'],
      ['pix', 'p_sent_pending'],
      ['pix', 'p_sent_opened'],
      ['message', 'm2'],
    ]);
  });

  it('omits payload data and captions from pix timeline items so captions cannot leak in chat', () => {
    const pix = [
      entry('p_new', 20, BOB.userId, { conversationId: convId, caption: 'hidden until opened', mediaRef: 'r1' }),
    ];

    const [item] = chatTimeline([], pix, convId, ME);

    expect(item).toEqual({
      kind: 'pix',
      id: 'p_new',
      sentAt: 20,
      authorUserId: BOB.userId,
      status: 'received_new',
    });
    expect('data' in item).toBe(false);
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
    const messages = [withBob('m1', 10, BOB.userId), withBob('m2', 20, ME)];
    const pix = [withBob('p1', 5, BOB.userId), withBob('p2', 30, BOB.userId, 31), withBob('p3', 6, BOB.userId)];

    const [bob, carol] = friendActivities([CAROL, BOB], ME, messages, pix);

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
    const [unopenedActivity] = friendActivities([BOB], ME, [], [withBob('p1', 10, BOB.userId), withBob('p2', 20, BOB.userId)]);
    expect(activityPreview(unopenedActivity, ME)).toEqual({ text: '2 new pix · tap to view', highlight: true });
    expect(unopenedActivity.badge).toEqual({ kind: 'new', count: 2 });

    const [sentPixActivity] = friendActivities([BOB], ME, [], [withBob('p3', 30, ME)]);
    expect(activityPreview(sentPixActivity, ME)).toEqual({ text: 'Pix delivered', highlight: false });
    expect(sentPixActivity.badge).toEqual({ kind: 'sent' });

    const [msgActivity] = friendActivities([BOB], ME, [entry('m1', 40, ME, { conversationId: conversationId(ME, BOB.userId), content: 'yo' })], [withBob('p3', 30, ME)]);
    expect(activityPreview(msgActivity, ME)).toEqual({ text: 'You: yo', highlight: false });
    expect(pixBadgeFor(0, 'sent_opened')).toEqual({ kind: 'opened' });
  });
});

describe('storyGroups', () => {
  const NOW = 10 * STORY_MAX_AGE_MS;
  const identity = { myUserId: ME, myUsername: 'me', friends: [BOB, CAROL, DAVE] };

  it('groups live stories by author, mine apart, freshest friend first', () => {
    const stories = [
      entry('b1', NOW - 3, BOB.userId), entry('c1', NOW - 2, CAROL.userId),
      entry('b2', NOW - 1, BOB.userId), entry('m1', NOW - 4, ME),
    ];

    const { mine, others } = storyGroups(stories, identity, NOW);

    expect(mine).toMatchObject({ userId: ME, username: 'me' });
    expect(mine.stories.map((s) => s.id)).toEqual(['m1']);
    expect(others.map((g) => [g.username, g.stories.map((s) => s.id)])).toEqual([
      ['bob', ['b1', 'b2']], ['carol', ['c1']],
    ]);
  });

  it('hides expired stories and authors who are not accepted friends', () => {
    const stories = [
      entry('old', NOW - STORY_MAX_AGE_MS, BOB.userId),
      entry('d', NOW - 1, DAVE.userId),
      entry('s', NOW - 1, 'uStranger'),
    ];

    const { mine, others } = storyGroups(stories, identity, NOW);

    expect(mine.stories).toEqual([]);
    expect(others).toEqual([]);
  });
});
