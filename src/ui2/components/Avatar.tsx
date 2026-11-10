import React, { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { useIsFocused, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { PIX_PEEK, TIMING } from '../motion';

// claude: the board's avatar colors (its chat list). Profile color is pending in the data, so one is picked from
// the username until it lands.
const AVATAR_COLORS = [
  '#FFB23F', '#7ED957', '#FFD21A', '#B79CF2', '#62C6F3', '#FFE07A', '#FF8FB1', '#9FE3C4',
  '#FF9F6B', '#A7D8FF', '#D7E3FF', '#FFC2D9', '#B8F0A6', '#E8D4FF', '#FFB3A7',
];

export function avatarColor(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 2147483647;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

interface AvatarProps {
  name: string;
  size: number;
  radius: number;
  outline: string;
  ink: string;
  background?: string;
  // claude: your own avatar's character, from the ui2 store
  emoji?: string | null;
  // claude: the board's photo-chat avatar: a bigger letter, shifted and cropped
  cropped?: boolean;
  // claude: the cropped avatar's place among the rows, so the faces peek out one after another
  peekOrder?: number;
}

interface CroppedFaceProps {
  k: number;
  order: number;
  style: StyleProp<TextStyle>;
  children: React.ReactNode;
}

// claude: the pink avatar starts as a plain pink square; each time the screen opens the face peeks round its left
// edge, sliding and twisting, like someone looking round a wall corner.
function CroppedFace({ k, order, style, children }: CroppedFaceProps) {
  const peek = useSharedValue(0);
  const focused = useIsFocused();
  const nav = useNavigation();
  const routeKey = useRoute().key;
  const play = useCallback(() => {
    peek.value = withDelay(PIX_PEEK.hold + order * PIX_PEEK.stagger, withTiming(1, TIMING.faceSlide));
  }, [peek, order]);
  // claude: a swipe back only changes focus once it has finished, so the stack's transition start is what says this
  // screen has begun to appear; `started` stops the later focus from replaying it.
  const started = useRef(false);
  useEffect(() => {
    const stack = nav.getParent<NativeStackNavigationProp<RootStackParamList>>();
    if (!stack) return undefined;
    const offStart = stack.addListener('transitionStart', e => {
      const tabs = nav.getState();
      if (e.data.closing || tabs?.routes[tabs.index]?.key !== routeKey) return;
      started.current = true;
      play();
    });
    // claude: fully covered, including a swipe back that was let go of, so the next return starts plain pink
    const offEnd = stack.addListener('transitionEnd', e => {
      if (!e.data.closing) return;
      started.current = false;
      peek.value = 0;
    });
    return () => {
      offStart();
      offEnd();
    };
  }, [nav, routeKey, play, peek]);
  useEffect(() => {
    if (focused) {
      if (!started.current) play();
      started.current = false;
      return;
    }
    // claude: hidden again only once the screen is covered, so coming back shows plain pink and never a flicker
    peek.value = withDelay(PIX_PEEK.resetAfter, withTiming(0, { duration: 0 }));
  }, [focused, peek, play]);
  const slide = useAnimatedStyle(() => ({
    transform: [
      { translateX: (PIX_PEEK.hiddenX + (PIX_PEEK.restX - PIX_PEEK.hiddenX) * peek.value) * k },
      { translateY: 4 * k },
      { rotate: `${PIX_PEEK.tilt * peek.value}deg` },
    ],
  }));
  return <Animated.Text style={[style, slide]}>{children}</Animated.Text>;
}

// claude: a letter stands in for the profile emoji, which the data does not have yet.
export function Avatar({ name, size, radius, outline, ink, background, emoji, cropped, peekOrder = 0 }: AvatarProps) {
  const k = size / 48;
  const fontSize = cropped ? 38 * k : 28 * k;
  const face = emoji ?? name[0]?.toUpperCase() ?? '?';
  const letter = [styles.letter, { color: ink, fontSize, lineHeight: fontSize * 1.15 }];
  return (
    <View
      style={[
        styles.box,
        {
          width: size, height: size, borderRadius: radius,
          backgroundColor: background ?? avatarColor(name),
          borderColor: outline, boxShadow: `0 3px 0 ${outline}`,
        },
      ]}
    >
      {cropped ? <CroppedFace k={k} order={peekOrder} style={letter}>{face}</CroppedFace> : <Text style={letter}>{face}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { fontWeight: '900', includeFontPadding: false },
});
