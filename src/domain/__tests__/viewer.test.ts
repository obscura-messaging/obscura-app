import { stepViewer } from '../viewer';

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
