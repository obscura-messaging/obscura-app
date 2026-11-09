// claude: numbers from react-native-experiments/docs/motion.md, shaped for Reanimated's withSpring / withTiming.
import { Easing } from 'react-native';

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

export interface Timing {
  duration: number;
  easing: (value: number) => number;
}

export const EASING = {
  backOut: Easing.bezier(0.34, 1.56, 0.64, 1),
  // claude: CSS `ease-out`.
  easeOut: Easing.bezier(0, 0, 0.58, 1),
  timestampSnap: Easing.bezier(0.2, 1.4, 0.4, 1),
  swipeRowSnap: Easing.bezier(0.2, 1.25, 0.4, 1),
  pullSettle: Easing.bezier(0.2, 1.2, 0.4, 1),
  spinnerRover: Easing.bezier(0.55, 0, 0.45, 1),
} as const;

export const SPRING = {
  sliderBall: { stiffness: 310, damping: 22, mass: 1 },
  grabSwell: { stiffness: 420, damping: 28, mass: 1 },
} as const satisfies Record<string, Spring>;

export const TIMING = {
  timestampSnap: { duration: 360, easing: EASING.timestampSnap },
  swipeRowSnap: { duration: 340, easing: EASING.swipeRowSnap },
  pullSettle: { duration: 260, easing: EASING.pullSettle },
  shutterPress: { duration: 90, easing: EASING.easeOut },
  shutterColor: { duration: 120, easing: EASING.easeOut },
  spinnerRover: { duration: 1500, easing: EASING.spinnerRover },
} as const satisfies Record<string, Timing>;

export const GRAB_SWELL_SCALE = 1.12;
export const SHUTTER_PRESS_SCALE = 0.9;

// claude: 1:1 to the limit, then this factor past it.
export const RUBBER_BAND = { swipe: 0.3, pull: 0.3, timestamps: 0.25 } as const;

export const TYPING_DOTS = { loop: 1100, stagger: 150, rise: 4, opacityFrom: 0.45, opacityTo: 1 } as const;
