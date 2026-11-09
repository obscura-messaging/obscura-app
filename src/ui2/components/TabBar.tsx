import React, { useState } from 'react';
import { Pressable, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
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

const noop = () => undefined;

// claude: on the camera page the shutter lives in this bar; the camera screen plugs its capture in here.
export const cameraShutter = { pressIn: noop, pressOut: noop };

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

function CameraShutter({ yellow, rec }: { yellow: string; rec: string }) {
  const [pressed, setPressed] = useState(false);
  const scale = useSharedValue(1);
  const domeStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const press = (down: boolean) => {
    setPressed(down);
    scale.value = withTiming(down ? SHUTTER_PRESS_SCALE : 1, TIMING.shutterPress);
    if (down) cameraShutter.pressIn();
    else cameraShutter.pressOut();
  };
  const color = pressed ? rec : yellow;
  return (
    <Pressable
      onPressIn={() => press(true)}
      onPressOut={() => press(false)}
      style={[styles.glassShutter, { borderColor: color }]}
      accessibilityLabel="Take photo"
    >
      <Animated.View style={[styles.dome, { backgroundColor: color }, domeStyle]} />
    </Pressable>
  );
}

export function TabBar({ state, navigation }: MaterialTopTabBarProps) {
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
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (current !== name && !event.defaultPrevented) navigation.navigate(name);
  };
  const tint = (name: string) => (current === name ? theme.yellow : theme.barIcon);

  const tabs = (center: React.ReactNode) => (
    <View pointerEvents="box-none" style={[styles.row, onCamera ? styles.rowGlass : styles.rowSolid]}>
      <TouchableOpacity style={styles.tab} onPress={() => go('Chats')} accessibilityLabel="Chats">
        <ChatIcon color={tint('Chats')} />
      </TouchableOpacity>
      <View pointerEvents="box-none" style={styles.tab}>{center}</View>
      <TouchableOpacity style={styles.tab} onPress={() => go('ProfileTab')} accessibilityLabel="Profile">
        <ProfileIcon color={tint('ProfileTab')} />
      </TouchableOpacity>
    </View>
  );

  if (onCamera) {
    const h = GLASS_H + insets.bottom;
    return (
      <View pointerEvents="box-none" style={[styles.host, { height: h }]}>
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={width} height={h}>
          <Path d={glassPath(width, h, c)} fill={withAlpha(theme.bar, 56)} />
        </Svg>
        {tabs(<CameraShutter yellow={theme.yellow} rec={theme.rec} />)}
      </View>
    );
  }

  const hair = DARK_OVERLAY.barOutline;
  return (
    <View pointerEvents="box-none" style={[styles.host, { height: BAR_H + insets.bottom }]}>
      <View pointerEvents="none" style={[styles.solid, { backgroundColor: theme.bar }]} />
      <Svg pointerEvents="none" style={styles.outline} width={width} height={60} viewBox={`0 0 ${width} 60`}>
        {filletPaths(c).map(d => <Path key={d} d={d} fill={theme.bar} />)}
        {mode === 'dark' && (
          <Path d={hairPath(width, c)} fill="none" stroke={withAlpha(hair.color, hair.alpha)} strokeWidth={hair.width} />
        )}
      </Svg>
      {tabs(
        <TouchableOpacity
          style={[styles.shutter, { backgroundColor: theme.yellow, borderColor: theme.bar }]}
          onPress={() => go('Camera')}
          accessibilityLabel="Open camera"
        >
          <Svg width={SHUTTER - 2 * RIM} height={SHUTTER - 2 * RIM} viewBox="2 2 20 20">
            <Polygon points={SHUTTER_ICON.hexagon} fill={theme.bar} />
            <Path
              d={SHUTTER_ICON.blades} fill="none" stroke={theme.bar} strokeWidth={0.9}
              strokeLinecap="round" strokeLinejoin="round"
            />
          </Svg>
        </TouchableOpacity>,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10 },
  solid: { ...StyleSheet.absoluteFill, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  outline: { position: 'absolute', left: 0, top: -30 },
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8 },
  rowSolid: { paddingTop: 16 },
  rowGlass: { paddingTop: 56 },
  tab: { flex: 1, alignItems: 'center' },
  shutter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: RIM, marginTop: -44,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  glassShutter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: RIM, padding: 5, marginTop: -48,
  },
  dome: { flex: 1, borderRadius: SHUTTER / 2 },
});
