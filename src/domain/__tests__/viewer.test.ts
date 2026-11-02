import type { PixItem } from '../chats';
import type { Friend } from '../friends';
import {
  pixToSlide, pixViewerGroups, stepViewer, storyToSlide, storyViewerGroups, type StoryItem,
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
  });

  it('forbids rewinding when lockRewind is true (view-once pix)', () => {
    expect(stepViewer({ groupIdx: 0, storyIdx: 1 }, [3], 'rewind', true)).toEqual({
      kind: 'stay',
    });
  });

  it('closes immediately when the current group is empty or out of bounds', () => {
    expect(stepViewer({ groupIdx: 0, storyIdx: 0 }, [], 'advance')).toEqual({ kind: 'close' });
    expect(stepViewer({ groupIdx: 0, storyIdx: 2 }, [2], 'advance')).toEqual({ kind: 'close' });
  });
});

describe('slide projections & viewer groups', () => {
  const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
  const identity = { myUserId: 'uMe', myUsername: 'me', friends: [BOB] };

  it('maps stories and pix into ViewerSlide and builds storyViewerGroups and pixViewerGroups', () => {
    const story: StoryItem = {
      id: 's1',
      authorUserId: BOB.userId,
      sentAt: 100,
      content: 'hello story',
      attachment: { id: 'att_s', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
      captionMeta: { style: 'bar', y: 0.5 },
    };
    const pix: PixItem = {
      kind: 'pix',
      id: 'p1',
      peerUserId: BOB.userId,
      authorUserId: BOB.userId,
      sentAt: 200,
      viewedAt: null,
      attachment: { id: 'att_p', contentKey: 'k', nonce: 'n', mediaType: 'video' },
      caption: 'watch this',
      captionMeta: null,
      displayDuration: 10,
    };

    expect(storyToSlide(story)).toEqual({
      id: 's1',
      sentAt: 100,
      text: 'hello story',
      captionMeta: { style: 'bar', y: 0.5 },
      attachment: story.attachment,
    });
    expect(pixToSlide(pix)).toEqual({
      id: 'p1',
      sentAt: 200,
      text: 'watch this',
      captionMeta: null,
      attachment: pix.attachment,
      displayDuration: 10,
    });

    expect(storyViewerGroups([story], identity, BOB.userId)).toEqual({
      groups: [{ userId: BOB.userId, username: 'bob', stories: [storyToSlide(story)] }],
      initialGroupIdx: 0,
    });
    expect(pixViewerGroups([pix], BOB.userId, 'fallback', ['p1'], [BOB])).toEqual({
      groups: [{ userId: BOB.userId, username: 'bob', stories: [pixToSlide(pix)] }],
      initialGroupIdx: 0,
    });
  });
});
