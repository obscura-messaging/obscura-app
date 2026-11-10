import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView, useNativeGesture, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { saveOwnProfile } from '../../state/store';
import { toast } from '../../state/toast';
import { errorMessage } from '../../utils/log';
import { PALETTES, type ResolvedTheme } from '../theme';
import { TIMING } from '../motion';
import { FONT } from '../font';
import { setPalette, setProfileColor, setProfileEmoji, setThemeMode, useUi2, type ThemeMode } from '../store';
import { Avatar, avatarColor } from './Avatar';

// claude: the board's EMOJI and COLORS lists
const EMOJI = ['🐻', '🐯', '🦝', '🐧', '🐘', '🦁', '🐼', '🐸', '🦊', '🐨', '🐵', '🐮', '🐹', '🐢', '🐰', '🐙', '🐊', '🦄'];
const COLORS = ['#FFFFFF', '#FFD21A', '#FFB23F', '#FF8FB1', '#B79CF2', '#62C6F3', '#7ED957', '#9FE3C4', '#FF9F6B', '#15171C'];
const MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Light' },
  { mode: 'dark', label: 'Dark' },
];

interface SheetProps {
  visible: boolean;
  title: string;
  theme: ResolvedTheme;
  onDone: () => void;
  children: React.ReactNode;
}

// claude: how far (px) or how fast (px/s) a downward drag has to be to close the card
const CLOSE_DRAG = 100;
const CLOSE_VELOCITY = 800;

// claude: the board's .editor card: slides up over the profile. The X, a tap above it, or dragging it down closes it.
function Sheet({ visible, title, theme, onDone, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const y = useSharedValue(0);
  const scrollY = useSharedValue(0);
  // claude: the finger's travel while the content was still scrolling back to the top, so the card follows from there
  const anchor = useSharedValue(0);
  useEffect(() => {
    if (visible) {
      y.value = 0;
      scrollY.value = 0;
    }
  }, [visible, y, scrollY]);
  const onScroll = useAnimatedScrollHandler(e => { scrollY.value = e.contentOffset.y; });
  const scroll = useNativeGesture({});
  const drag = usePanGesture({
    activeOffsetY: 8,
    failOffsetX: [-12, 12],
    simultaneousWith: scroll,
    onBegin: () => {
      'worklet';
      anchor.value = 0;
    },
    onUpdate: e => {
      'worklet';
      if (scrollY.value > 0) {
        anchor.value = e.translationY;
        return;
      }
      y.value = Math.max(0, e.translationY - anchor.value);
    },
    onDeactivate: e => {
      'worklet';
      if (y.value > CLOSE_DRAG || (y.value > 0 && e.velocityY > CLOSE_VELOCITY)) scheduleOnRN(onDone);
      else y.value = withTiming(0, TIMING.pullSettle);
    },
  });
  // claude: clamped so the settle's overshoot never lifts the card off the bottom edge
  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(0, y.value) }] }));
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDone}>
      <GestureHandlerRootView style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onDone} accessibilityLabel="Close" />
        <GestureDetector gesture={drag}>
          <Animated.View style={[styles.card, { top: insets.top + 46, backgroundColor: theme.paper }, cardStyle]}>
            <GestureDetector gesture={scroll}>
              <Animated.ScrollView
                contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
                keyboardShouldPersistTaps="handled"
                automaticallyAdjustKeyboardInsets
                bounces={false}
                onScroll={onScroll}
                scrollEventThrottle={16}
              >
                <View style={styles.head}>
                  <Text style={[styles.title, { color: theme.ink }]}>{title}</Text>
                  <TouchableOpacity style={styles.close} onPress={onDone} accessibilityLabel="Close">
                    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
                      <Path d="M6 6l12 12M18 6L6 18" stroke={theme.ink} strokeWidth={2.6} strokeLinecap="round" />
                    </Svg>
                  </TouchableOpacity>
                </View>
                {children}
              </Animated.ScrollView>
            </GestureDetector>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

export function ThemeSheet({ visible, theme, onDone }: { visible: boolean; theme: ResolvedTheme; onDone: () => void }) {
  const mode = useUi2(s => s.mode);
  const palette = useUi2(s => s.palette);
  return (
    <Sheet visible={visible} title="Theme" theme={theme} onDone={onDone}>
      <View style={[styles.segments, { borderColor: theme.outline, backgroundColor: theme.paper }]}>
        {MODES.map(m => {
          const on = m.mode === mode;
          return (
            <TouchableOpacity
              key={m.mode}
              style={[styles.segment, on && { backgroundColor: theme.ink }]}
              onPress={() => setThemeMode(m.mode)}
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.segmentText, { color: on ? theme.paper : theme.ink }]}>{m.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[styles.label, { color: theme.muted }]}>Palette</Text>
      <View style={styles.palettes}>
        {PALETTES.map(p => {
          const on = p.name === palette;
          return (
            <TouchableOpacity
              key={p.name}
              style={[
                styles.palette,
                { backgroundColor: theme.paper, borderColor: on ? theme.outline : theme.line },
                on && { boxShadow: `0 3px 0 ${theme.outline}` },
              ]}
              onPress={() => setPalette(p.name)}
              accessibilityState={{ selected: on }}
            >
              <View style={styles.dots}>
                {[p.yellow, p.blue, p.alert].map((c, i) => (
                  <View key={i} style={[styles.dot, { backgroundColor: c, borderColor: theme.paper }]} />
                ))}
              </View>
              <Text style={[styles.paletteName, { color: theme.ink }]}>{p.name}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </Sheet>
  );
}

interface EditProps {
  visible: boolean;
  theme: ResolvedTheme;
  username: string;
  displayName: string;
  bio: string;
  onDone: () => void;
}

export function EditProfileSheet({ visible, theme, username, displayName, bio, onDone }: EditProps) {
  const emoji = useUi2(s => s.emoji);
  const color = useUi2(s => s.color);
  const [name, setName] = useState(displayName);
  const [about, setAbout] = useState(bio);

  useEffect(() => {
    if (visible) {
      setName(displayName);
      setAbout(bio);
    }
  }, [visible, displayName, bio]);

  const done = () => {
    onDone();
    const n = name.trim();
    const b = about.trim();
    if (n === displayName && b === bio) return;
    saveOwnProfile(n, b).catch(e => toast.error(errorMessage(e)));
  };

  const input = { color: theme.ink, backgroundColor: theme.paper, borderColor: theme.outline };
  const label = [styles.label, { color: theme.muted }];
  return (
    <Sheet visible={visible} title="Edit profile" theme={theme} onDone={done}>
      <View style={styles.preview}>
        <Avatar
          name={username} size={76} radius={22} outline={theme.outline} ink={theme.onSecondary.ink}
          emoji={emoji} background={color ?? avatarColor(username)}
        />
      </View>
      <Text style={label}>Character</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.emojiRow}>
        {EMOJI.map(e => {
          const on = e === emoji;
          return (
            <TouchableOpacity
              key={e}
              style={[
                styles.emoji,
                { borderColor: theme.outline, backgroundColor: on ? theme.sun : theme.paper },
                on && { boxShadow: `0 3px 0 ${theme.outline}` },
              ]}
              onPress={() => setProfileEmoji(e)}
              accessibilityState={{ selected: on }}
            >
              <Text style={styles.emojiText}>{e}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <Text style={label}>Color</Text>
      <View style={styles.swatches}>
        {COLORS.map(c => {
          const on = c === color;
          return (
            <TouchableOpacity
              key={c}
              style={[
                styles.swatch,
                { backgroundColor: c, borderColor: theme.outline },
                on && { boxShadow: `0 0 0 3px ${theme.paper}, 0 0 0 5px ${theme.ink}` },
              ]}
              onPress={() => setProfileColor(c)}
              accessibilityLabel={`Color ${c}`}
              accessibilityState={{ selected: on }}
            />
          );
        })}
      </View>
      <Text style={label}>Name</Text>
      <TextInput style={[styles.input, input]} value={name} onChangeText={setName} maxLength={24} autoCorrect={false} />
      <Text style={label}>Bio</Text>
      <TextInput
        style={[styles.input, styles.bio, input]} value={about} onChangeText={setAbout} maxLength={80}
        multiline numberOfLines={2}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  card: {
    position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    boxShadow: '0 -10px 30px -10px rgba(0, 0, 0, 0.35)',
  },
  content: { padding: 16, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontFamily: FONT[900] },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, fontFamily: FONT[900], marginTop: 6 },
  segments: { flexDirection: 'row', padding: 3, gap: 3, borderWidth: 2, borderRadius: 999 },
  segment: { flex: 1, height: 34, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontFamily: FONT[900] },
  palettes: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  palette: { width: '48%', flexGrow: 1, gap: 8, padding: 10, borderWidth: 2, borderRadius: 18 },
  dots: { flexDirection: 'row' },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, marginRight: -6 },
  paletteName: { fontSize: 13, fontFamily: FONT[900] },
  preview: { alignSelf: 'center', marginTop: 4, marginBottom: 6 },
  emojiRow: { gap: 8, paddingTop: 2, paddingHorizontal: 2, paddingBottom: 5 },
  emoji: { width: 42, height: 42, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 24 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 4 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2 },
  input: { fontSize: 13, fontFamily: FONT[700], borderWidth: 2, borderRadius: 999, height: 40, paddingHorizontal: 14, paddingVertical: 0 },
  bio: { height: undefined, minHeight: 60, borderRadius: 20, paddingVertical: 10, lineHeight: 17.5, textAlignVertical: 'top' },
});
