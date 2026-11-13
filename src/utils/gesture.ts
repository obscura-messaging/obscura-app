export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Distance between the first two touches. */
export const touchDist = (touches: ReadonlyArray<{ pageX: number; pageY: number }>) =>
  Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

/** Whether a pan gesture is a deliberate horizontal swipe to the right (back navigation). */
export const isBackSwipeGesture = (dx: number, dy: number): boolean =>
  dx > 16 && Math.abs(dx) > Math.abs(dy) * 2;

/** Whether a released right-swipe travelled far or fast enough to pop the screen. */
export const shouldCompleteBackSwipe = (dx: number, vx: number): boolean =>
  dx > 72 || (dx > 32 && vx > 0.5);
