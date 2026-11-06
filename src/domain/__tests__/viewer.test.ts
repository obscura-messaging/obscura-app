import type { ConversationItem, PixItem } from '../chats';
import type { Friend } from '../friends';
import {
  pixToSlide, pixViewerGroups, stepViewer, storyGroups, storyToSlide, storyViewerGroups, type StoryItem,
} from '../viewer';

describe('stepViewer', () => {
  it('advances through stories in a group, turns the cube to the next group, and closes at the end', () => {
    const lengths = [2, 1];
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, lengths, 'advance')).toEqual({
      kind: 'step',
      cursor: { groupIdx: 0, storyIdx: 1 },
    });
    expect(stepViewer({ groupIdx: 0, storyIdx: 1 }, lengths, 'advance')).toEqual({
      kind: 'turnCube',
      cursor: { groupIdx: 1, storyIdx: 0 },
      direction: 1,
    });
    expect(stepViewer({ groupIdx: 1, storyIdx: 0 }, lengths, 'advance')).toEqual({
      kind: 'close',
    });
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, [1, 0], 'advance')).toEqual({
      kind: 'close',
    });
  });

  it('rewinds within a group, turns the cube to the previous group, and stays at the very beginning', () => {
    const lengths = [2, 2];
    expect(stepViewer({ groupIdx: 1, storyIdx: 1 }, lengths, 'rewind')).toEqual({
      kind: 'step',
      cursor: { groupIdx: 1, storyIdx: 0 },
    });
    expect(stepViewer({ groupIdx: 1, storyIdx: 0 }, lengths, 'rewind')).toEqual({
      kind: 'turnCube',
      cursor: { groupIdx: 0, storyIdx: 0 },
      direction: -1,
    });
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, lengths, 'rewind')).toEqual({
      kind: 'stay',
    });
    expect(stepViewer({ groupIdx: 1, storyIdx: 0 }, [0, 1], 'rewind')).toEqual({
      kind: 'stay',
    });
  });

  it('forbids rewinding when lockRewind is true (view-once pix)', () => {
    expect(stepViewer({ groupIdx: 0, storyIdx: 1 }, [3], 'rewind', true)).toEqual({
      kind: 'stay',
    });
  });

  it('closes immediately when the current group is empty or out of bounds', () => {
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, [], 'advance')).toEqual({ kind: 'close' });
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, [0, 1], 'advance')).toEqual({ kind: 'close' });
    expect(stepViewer({ groupIdx: 0, storyIdx: 2 }, [2, 1], 'advance')).toEqual({ kind: 'close' });
    expect(stepViewer({ groupIdx: 0, storyIdx: 2 }, [2], 'rewind')).toEqual({ kind: 'close' });
  });
});

describe('slide projections & viewer groups', () => {
  const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
  const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };
  const identity = { myUserId: 'uMe', myUsername: 'me', friends: [BOB, CAROL] };

  it('maps stories and pix into ViewerSlide and builds storyViewerGroups and pixViewerGroups', () => {
    const storyOlder: StoryItem = {
      id: 's1',
      authorUserId: BOB.userId,
      sentAt: 100,
      content: 'hello story',
      attachment: { id: 'att_s', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
      captionMeta: { style: 'bar', y: 0.5 },
    };
    const storyNewer: StoryItem = {
      id: 's2',
      authorUserId: BOB.userId,
      sentAt: 200,
      content: 'second story',
      attachment: null,
      captionMeta: null,
    };
    const carolStory: StoryItem = {
      id: 's3',
      authorUserId: CAROL.userId,
      sentAt: 300,
      content: 'carol story',
      attachment: null,
      captionMeta: null,
    };

    const grouped = storyGroups([storyNewer, storyOlder, carolStory], identity);
    expect(grouped.others.map((g) => g.userId)).toEqual([CAROL.userId, BOB.userId]);
    expect(grouped.others[1].stories.map((s) => s.sentAt)).toEqual([100, 200]);

    const pix1: PixItem = {
      kind: 'pix',
      id: 'p1',
      peerUserId: BOB.userId,
      authorUserId: BOB.userId,
      sentAt: 100,
      viewedAt: null,
      attachment: { id: 'att_p', contentKey: 'k', nonce: 'n', mediaType: 'video' },
      caption: 'watch this',
      captionMeta: null,
      displayDuration: 10,
    };
    const pix2: PixItem = {
      ...pix1,
      id: 'p2',
      sentAt: 300,
      caption: null,
    };
    const unwantedPix: PixItem = {
      ...pix1,
      id: 'p_unwanted',
      sentAt: 150,
    };
    const msgWithWantedId: ConversationItem = {
      kind: 'message',
      id: 'm1',
      peerUserId: BOB.userId,
      authorUserId: BOB.userId,
      sentAt: 50,
      viewedAt: null,
      content: 'not a pix',
    };

    expect(storyToSlide(storyOlder)).toEqual({
      id: 's1',
      sentAt: 100,
      text: 'hello story',
      captionMeta: { style: 'bar', y: 0.5 },
      attachment: storyOlder.attachment,
    });
    expect(pixToSlide(pix1)).toEqual({
      id: 'p1',
      sentAt: 100,
      text: 'watch this',
      captionMeta: null,
      attachment: pix1.attachment,
      displayDuration: 10,
    });

    const viewer = storyViewerGroups([storyNewer, storyOlder, carolStory], identity, BOB.userId);
    expect(viewer).toEqual({
      groups: [
        { userId: CAROL.userId, username: 'carol', stories: [storyToSlide(carolStory)] },
        { userId: BOB.userId, username: 'bob', stories: [storyToSlide(storyOlder), storyToSlide(storyNewer)] },
      ],
      initialGroupIdx: 1,
    });
    expect(storyViewerGroups([storyOlder, carolStory], identity, 'uUnknown').initialGroupIdx).toBe(0);

    expect(
      pixViewerGroups([pix2, msgWithWantedId, unwantedPix, pix1], BOB.userId, 'fallback', ['p1', 'p2', 'm1'], [CAROL, BOB]),
    ).toEqual({
      groups: [{ userId: BOB.userId, username: 'bob', stories: [pixToSlide(pix1), pixToSlide(pix2)] }],
      initialGroupIdx: 0,
    });
    expect(
      pixViewerGroups([pix1], 'uUnlisted', 'fallbackName', ['p1'], [BOB]),
    ).toEqual({
      groups: [{ userId: 'uUnlisted', username: 'fallbackName', stories: [pixToSlide(pix1)] }],
      initialGroupIdx: 0,
    });
    expect(pixViewerGroups([msgWithWantedId], BOB.userId, 'fallback', ['m1'], [BOB])).toEqual({
      groups: [],
      initialGroupIdx: 0,
    });
  });
});
