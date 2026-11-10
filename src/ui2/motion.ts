// claude: numbers from react-native-experiments/docs/motion.md, shaped for Reanimated's withTiming.
// claude: Reanimated's Easing, so these run as worklets on the UI thread.
import { Easing, type EasingFunction, type EasingFunctionFactory } from 'react-native-reanimated';

export interface Timing {
  duration: number;
  easing: EasingFunction | EasingFunctionFactory;
}

export const EASING = {
  backOut: Easing.bezier(0.34, 1.56, 0.64, 1),
  // claude: CSS `ease-out`.
  easeOut: Easing.bezier(0, 0, 0.58, 1),
  pullSettle: Easing.bezier(0.2, 1.2, 0.4, 1),
} as const;

export const TIMING = {
  pullSettle: { duration: 260, easing: EASING.pullSettle },
  shutterPress: { duration: 90, easing: EASING.easeOut },
  // claude: the tab bar swapping to and from the camera's glass bar, both ways, with a playful overshoot
  cameraSwap: { duration: 340, easing: EASING.backOut },
  // claude: the bar going solid the moment you leave the camera: almost instant
  barSolid: { duration: 70, easing: EASING.easeOut },
  // claude: an emoji arriving when its screen opens: the chat peek rising, the pink avatar's face sliding out
  faceSlide: { duration: 340, easing: EASING.backOut },
} as const satisfies Record<string, Timing>;

// claude: the pink avatar's face peeking out: plain pink for `hold` ms, then one row after another `stagger` ms apart.
// hiddenX is past the square's left edge, restX is the board's -10, both at a 48 px avatar; tilt is in degrees.
// resetAfter is ms after leaving the screen, long enough for the next screen to have covered it.
export const PIX_PEEK = { hold: 250, stagger: 60, hiddenX: -60, restX: -10, tilt: 16, resetAfter: 150 } as const;

// claude: the chat list's pull-down, the board's PULL_MAX and its 5 px direction check. travel caps the finger's pull.
export const PULL = { max: 56, travel: 1.6, slop: 5 } as const;

export const SHUTTER_PRESS_SCALE = 0.9;

// claude: 1:1 to the limit, then this factor past it.
export const RUBBER_BAND = { pull: 0.3 } as const;

export const TYPING_DOTS = { loop: 1100, stagger: 150, rise: 4, opacityFrom: 0.45, opacityTo: 1 } as const;
