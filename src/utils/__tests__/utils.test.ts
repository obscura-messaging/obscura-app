import { timeAgo } from '../format';
import { isBackSwipeGesture, shouldCompleteBackSwipe, touchDist } from '../gesture';
import { getJsLog, logError } from '../log';

describe('timeAgo', () => {
  it('formats compact relative timestamps across seconds, minutes, hours, and days', () => {
    const now = 1_700_000_000_000;
    expect(timeAgo(Date.now())).toBe('now');
    expect(timeAgo(now - 59_000, now)).toBe('now');
    expect(timeAgo(now - 60_000, now)).toBe('1m');
    expect(timeAgo(now - 3_599_000, now)).toBe('59m');
    expect(timeAgo(now - 3_600_000, now)).toBe('1h');
    expect(timeAgo(now - 86_399_000, now)).toBe('23h');
    expect(timeAgo(now - 86_400_000, now)).toBe('1d');
  });
});

describe('back swipe & touch gesture helpers', () => {
  it('computes Euclidean distance between two touches', () => {
    expect(
      touchDist([
        { pageX: 10, pageY: 20 },
        { pageX: 40, pageY: 60 },
      ]),
    ).toBe(50);
  });

  it('recognizes a deliberate horizontal right swipe and ignores vertical scrolling or left swipes', () => {
    expect(isBackSwipeGesture(24, 4)).toBe(true);
    expect(isBackSwipeGesture(17, 8)).toBe(true);
    expect(isBackSwipeGesture(16, 0)).toBe(false);
    expect(isBackSwipeGesture(16, 8)).toBe(false);
    expect(isBackSwipeGesture(20, 10)).toBe(false);
    expect(isBackSwipeGesture(10, 2)).toBe(false);
    expect(isBackSwipeGesture(-30, 2)).toBe(false);
    expect(isBackSwipeGesture(24, 15)).toBe(false);
  });

  it('completes a back swipe on sufficient distance or velocity', () => {
    expect(shouldCompleteBackSwipe(80, 0.1)).toBe(true);
    expect(shouldCompleteBackSwipe(73, 0)).toBe(true);
    expect(shouldCompleteBackSwipe(72, 0)).toBe(false);
    expect(shouldCompleteBackSwipe(40, 0.7)).toBe(true);
    expect(shouldCompleteBackSwipe(33, 0.51)).toBe(true);
    expect(shouldCompleteBackSwipe(33, 0.5)).toBe(false);
    expect(shouldCompleteBackSwipe(32, 0.6)).toBe(false);
    expect(shouldCompleteBackSwipe(40, 0.2)).toBe(false);
    expect(shouldCompleteBackSwipe(20, 0.9)).toBe(false);
  });
});

describe('logError & getJsLog', () => {
  it('records tagged warnings and caps the ring buffer at 200 lines', () => {
    for (let i = 0; i < 205; i += 1) {
      logError('ring', `line-${i}`);
    }
    const ring = getJsLog();
    expect(ring).toHaveLength(200);
    expect(ring[0]).toContain('line-5');
    expect(ring[ring.length - 1]).toContain('line-204');
  });
});
