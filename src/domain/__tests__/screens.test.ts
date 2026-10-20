import { friendActivities, conversationEntries } from '../chats';
import { conversationId } from '../conversation';
import { STORY_MAX_AGE_MS } from '../expiry';
import { displayMs, pixStatus } from '../pix';
import type { ScreenEntry } from '../seen';
import { storyGroups } from '../stories';
import type { Friend } from '../../native/ObscuraModule';

const ME = 'uMe';
const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };
const DAVE: Friend = { userId: 'uDave', username: 'dave', status: 'pending_received' };

function entry(id: string, sentAt: number, authorUserId: string, data: Record<string, unknown> = {}, viewedAt: number | null = null):
  ScreenEntry<{ conversationId: string }> {
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
    expect(carol).toEqual({ friend: CAROL, lastMessage: undefined, unopenedPix: [], latestPix: undefined, latestAt: 0 });
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
