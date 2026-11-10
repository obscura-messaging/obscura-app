import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import Animated, {
  Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withTiming,
} from 'react-native-reanimated';
import Svg, { Path, Polygon } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { DARK_OVERLAY, withAlpha } from '../theme';
import { useUi2Theme } from '../store';
import { SHUTTER_PRESS_SCALE, TIMING } from '../motion';

const BAR_H = 72;
const GLASS_H = 112;
const SHUTTER = 80;
const RIM = 5;
// claude: the white ring sits inside the bar-colored rim; ring line and gap are 4.5 px each
const RING = SHUTTER - 2 * RIM;
const RING_LINE = 4.5;
const DISC = RING - 4 * RING_LINE;
const WHITE = '#FFFFFF';

const noop = () => undefined;

// claude: on the camera page the shutter lives in this bar; the camera screen plugs its capture in here.
export const cameraShutter = { pressIn: noop, pressOut: noop };

// claude: the tab navigator's drag events, which the bar's props don't expose; RootNavigator forwards them here.
export const barPager = { swipeStart: noop, swipeEnd: noop };

// claude: the board's drawShutter at its defaults (open 3.6, angle -1): a hexagon plus six blade lines to the r 10 rim.
const SHUTTER_ICON = (() => {
  const open = 3.6;
  const angle = -1;
  const rad = (d: number) => (d * Math.PI) / 180;
  const corners = [0, 1, 2, 3, 4, 5].map(i => {
    const a = rad(-60 + 60 * i);
    return [12 + open * Math.cos(a), 12 + open * Math.sin(a), a];
  });
  const blades = corners.map(([x, y, a]) => {
    const d = a + rad(120 + angle);
    const dx = Math.cos(d);
    const dy = Math.sin(d);
    const b = (x - 12) * dx + (y - 12) * dy;
    const t = -b + Math.sqrt(b * b - ((x - 12) ** 2 + (y - 12) ** 2 - 100));
    return `M${x.toFixed(2)} ${y.toFixed(2)}L${(x + t * dx).toFixed(2)} ${(y + t * dy).toFixed(2)}`;
  }).join('');
  return { hexagon: corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '), blades };
})();

function ChatIcon({ color }: { color: string }) {
  return (
    <Svg width={29} height={29} viewBox="0 0 24 24">
      <Path fill={color} d="M4 5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H10l-4 4v-4H7a3 3 0 0 1-3-3z" />
    </Svg>
  );
}

function ProfileIcon({ color }: { color: string }) {
  return (
    <Svg width={29} height={29} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M6 2h12a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4zm6 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm-6 13h12a6 6 0 0 0-12 0z"
      />
    </Svg>
  );
}

// claude: the bar's top edge with r 8 fillets into the shutter rim (a circle r 40 centered 12 below the edge).
// Coordinates are the board's BAR_OUTLINE, with the bar's top edge at y 30.
const filletPaths = (c: number) => [
  `M${c - 43.63} 30A8 8 0 0 0 ${c - 36.36} 25.33A40 40 0 0 0 ${c - 38.16} 30Z`,
  `M${c + 43.63} 30A8 8 0 0 1 ${c + 36.36} 25.33A40 40 0 0 1 ${c + 38.16} 30Z`,
];
const hairPath = (w: number, c: number) =>
  `M0 56A26 26 0 0 1 26 30H${c - 43.63}A8 8 0 0 0 ${c - 36.36} 25.33A40 40 0 0 1 ${c + 36.36} 25.33` +
  `A8 8 0 0 0 ${c + 43.63} 30H${w - 26}A26 26 0 0 1 ${w} 56`;
// claude: the camera's frosted bar: the bar plus a bump (r 45) round the shutter, from the board's clip-path.
const glassPath = (w: number, h: number, c: number) =>
  `M0 66A26 26 0 0 1 26 40H${c - 50.53}A8 8 0 0 0 ${c - 42.9} 34.42A45 45 0 0 1 ${c + 42.9} 34.42` +
  `A8 8 0 0 0 ${c + 50.53} 40H${w - 26}A26 26 0 0 1 ${w} 66V${h}H0Z`;

// claude: which button sits in the solid bar. 'yellow' is the camera button's ring and disc; the two lenses keep
// the shutter blades. Flip this constant to switch.
export type ShutterLook = 'yellow' | 'whiteLens' | 'yellowLens';
export const SHUTTER_LOOK: ShutterLook = 'yellow';

// claude: off camera the button is the solid bar's ring size; on camera it grows to its own, so the size says
// "camera is active".
const GROW = RING / SHUTTER;
// claude: button center above the bar's bottom edge: solid 72 - (16 - 44 + 40) = 60, glass 112 - (56 - 48 + 40) = 64.
const LIFT = 4;

// claude: the lens looks' face, drawn over the button off camera.
function LensFace({ look, yellow, bar }: { look: ShutterLook; yellow: string; bar: string }) {
  const blades = (
    <Svg width={look === 'yellowLens' ? RING : DISC} height={look === 'yellowLens' ? RING : DISC} viewBox="2 2 20 20">
      <Polygon points={SHUTTER_ICON.hexagon} fill={bar} />
      <Path d={SHUTTER_ICON.blades} fill="none" stroke={bar} strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
  return look === 'yellowLens'
    ? <View style={[styles.lensFull, { backgroundColor: yellow }]}>{blades}</View>
    : (
      <View style={[styles.ring, { borderColor: WHITE }]}>
        <View style={[styles.disc, { backgroundColor: WHITE }]}>{blades}</View>
      </View>
    );
}

export function TabBar({ state, navigation, position }: MaterialTopTabBarProps) {
  const theme = useUi2Theme();
  const mode = theme.mode;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const current = state.routes[state.index]?.name;
  const onCamera = current === 'Camera';
  const c = width / 2;

  const go = (name: string) => {
    const route = state.routes.find(r => r.name === name);
    if (!route) return;
    if (name !== current) {
      if (onCamera) routeOnCamera.current = false;
      if (name === 'Camera') moving.current = 'tap';
      syncGlass();
    }
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (current !== name && !event.defaultPrevented) navigation.navigate(name);
  };
  const tint = (name: string) => (current === name ? theme.yellow : theme.barIcon);

  // claude: 0 off camera, 1 on camera, following the route. It drives the button's playful grow and shrink.
  const cam = useSharedValue(onCamera ? 1 : 0);
  // claude: the bar's see-through amount, separate from the button: it fades in playfully once on the camera, but
  // goes solid almost instantly the moment you tap away or start sliding off it.
  const glass = useSharedValue(onCamera ? 1 : 0);
  // claude: the glass shows only while the route is the camera and the pager is at rest, so it can never stick on
  // another tab. Position events go silent during a drag, so drags are read from the navigator's swipe events.
  const glassOn = useRef(onCamera);
  const routeOnCamera = useRef(onCamera);
  const moving = useRef<'drag' | 'tap' | null>(null);
  const syncGlass = useCallback(() => {
    const want = routeOnCamera.current && moving.current === null;
    if (want === glassOn.current) return;
    glassOn.current = want;
    glass.value = withTiming(want ? 1 : 0, want ? TIMING.cameraSwap : TIMING.barSolid);
  }, [glass]);
  useEffect(() => {
    cam.value = withTiming(onCamera ? 1 : 0, TIMING.cameraSwap);
    routeOnCamera.current = onCamera;
    syncGlass();
  }, [cam, onCamera, syncGlass]);
  useEffect(() => {
    barPager.swipeStart = () => {
      moving.current = 'drag';
      syncGlass();
    };
    barPager.swipeEnd = () => {
      moving.current = null;
      syncGlass();
    };
    return () => {
      barPager.swipeStart = noop;
      barPager.swipeEnd = noop;
    };
  }, [syncGlass]);
  const cameraIndex = state.routes.findIndex(r => r.name === 'Camera');
  useEffect(() => {
    // claude: a tap into the camera has no drag events; the pager reporting it has landed ends the wait
    const id = position.addListener(({ value }) => {
      if (moving.current === 'tap' && Math.abs(value - cameraIndex) < 0.002) {
        moving.current = null;
        syncGlass();
      }
    });
    return () => position.removeListener(id);
  }, [position, cameraIndex, syncGlass]);
  const solidStyle = useAnimatedStyle(() => ({ opacity: interpolate(glass.value, [0, 1], [1, 0], Extrapolation.CLAMP) }));
  const glassStyle = useAnimatedStyle(() => ({ opacity: interpolate(glass.value, [0, 1], [0, 1], Extrapolation.CLAMP) }));
  const moveStyle = useAnimatedStyle(() => ({ transform: [{ translateY: interpolate(cam.value, [0, 1], [LIFT, 0]) }] }));
  const growStyle = useAnimatedStyle(() => ({ transform: [{ scale: interpolate(cam.value, [0, 1], [GROW, 1]) }] }));

  const [pressed, setPressed] = useState(false);
  const press = useSharedValue(1);
  const domeStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  const shoot = (down: boolean) => {
    setPressed(down);
    press.value = withTiming(down ? SHUTTER_PRESS_SCALE : 1, TIMING.shutterPress);
    if (down) cameraShutter.pressIn();
    else cameraShutter.pressOut();
  };
  const color = onCamera && pressed ? theme.rec : theme.yellow;

  const h = GLASS_H + insets.bottom;
  const hair = DARK_OVERLAY.barOutline;
  const look: ShutterLook = SHUTTER_LOOK;
  return (
    <View pointerEvents="box-none" style={[styles.host, { height: h }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, solidStyle]}>
        <View style={[styles.solid, { height: BAR_H + insets.bottom, backgroundColor: theme.bar }]} />
        <Svg style={styles.outline} width={width} height={60} viewBox={`0 0 ${width} 60`}>
          {filletPaths(c).map(d => <Path key={d} d={d} fill={theme.bar} />)}
          {mode === 'dark' && (
            <Path d={hairPath(width, c)} fill="none" stroke={withAlpha(hair.color, hair.alpha)} strokeWidth={hair.width} />
          )}
        </Svg>
        <View style={[styles.notch, { left: c - SHUTTER / 2, backgroundColor: theme.bar }]} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, glassStyle]}>
        <Svg width={width} height={h}>
          <Path d={glassPath(width, h, c)} fill={withAlpha(theme.bar, 56)} />
        </Svg>
      </Animated.View>
      <View pointerEvents="box-none" style={styles.row}>
        <TouchableOpacity style={styles.tab} onPress={() => go('Chats')} accessibilityLabel="Chats">
          <ChatIcon color={tint('Chats')} />
        </TouchableOpacity>
        <View pointerEvents="box-none" style={styles.tab}>
          <Animated.View style={[styles.slot, moveStyle]}>
            <Animated.View style={growStyle}>
              <Pressable
                onPress={onCamera ? undefined : () => go('Camera')}
                onPressIn={onCamera ? () => shoot(true) : undefined}
                onPressOut={onCamera ? () => shoot(false) : undefined}
                style={[styles.button, { borderColor: color }]}
                accessibilityLabel={onCamera ? 'Take photo' : 'Open camera'}
              >
                <Animated.View style={[styles.dome, { backgroundColor: color }, domeStyle]} />
              </Pressable>
            </Animated.View>
            {look !== 'yellow' && (
              <Animated.View pointerEvents="none" style={[styles.face, solidStyle]}>
                <LensFace look={look} yellow={theme.yellow} bar={theme.bar} />
              </Animated.View>
            )}
          </Animated.View>
        </View>
        <TouchableOpacity style={styles.tab} onPress={() => go('ProfileTab')} accessibilityLabel="Profile">
          <ProfileIcon color={tint('ProfileTab')} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// claude: the host is the glass bar's height; the solid bar's top edge sits GLASS_H - BAR_H (40) below the host top,
// level with the glass shape's top edge.
const SOLID_TOP = GLASS_H - BAR_H;

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10 },
  solid: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  outline: { position: 'absolute', left: 0, top: SOLID_TOP - 30 },
  // claude: the notch the button sits in: r 40, centered 12 below the solid bar's top edge.
  notch: { position: 'absolute', top: SOLID_TOP + 12 - SHUTTER / 2, width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8, paddingTop: 56 },
  tab: { flex: 1, alignItems: 'center' },
  slot: { width: SHUTTER, height: SHUTTER, marginTop: -48 },
  face: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  ring: { width: RING, height: RING, borderRadius: RING / 2, borderWidth: RING_LINE, padding: RING_LINE },
  disc: { flex: 1, borderRadius: DISC / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  lensFull: { width: RING, height: RING, borderRadius: RING / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  button: { width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: RIM, padding: 5 },
  dome: { flex: 1, borderRadius: SHUTTER / 2 },
});
