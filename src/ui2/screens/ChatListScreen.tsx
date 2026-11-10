import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, type FlatList, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Reanimated, {
  cancelAnimation, interpolateColor, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedStyle, useSharedValue,
  withDecay, withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activityPreview, conversationItems, friendActivities, type FriendActivity } from '../../domain/chats';
import { storyGroups } from '../../domain/viewer';
import { usePeerTyping } from '../../state/chat';
import { openPixViewer } from '../../navigation/openPixViewer';
import type { RootStackParamList } from '../../navigation/types';
import { DARK_OVERLAY, withAlpha, type ResolvedTheme } from '../theme';
import { useUi2, useUi2Theme } from '../store';
import { PULL, RUBBER_BAND, TIMING, TYPING_DOTS } from '../motion';
import { FONT } from '../font';
import { useChatsData } from '../chatsData';
import type { SampleFace } from '../sample';
import { Avatar } from '../components/Avatar';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// claude: the board's friendlyTime: now, 5m, 8:01 PM (today), Yesterday, Mon (this week), 10/12 (older).
function friendlyTime(ts: number, now = Date.now()): string {
  const minutesAgo = (now - ts) / 60000;
  if (minutesAgo < 1) return 'now';
  if (minutesAgo < 60) return `${Math.floor(minutesAgo)}m`;
  const at = new Date(ts);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= startOfToday) {
    const h = at.getHours();
    return `${h % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
  const days = Math.ceil((startOfToday - ts) / 86400000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return DAYS[at.getDay()];
  return `${at.getMonth() + 1}/${at.getDate()}`;
}

// claude: three bouncing dots; the chat screen uses them too.
export function TypingDots({ color }: { color: string }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const step = TYPING_DOTS.loop * 0.3;
    const runs = dots.map((v, i) => Animated.sequence([
      Animated.delay(i * TYPING_DOTS.stagger),
      Animated.loop(Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: step, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: step, useNativeDriver: true }),
        Animated.delay(TYPING_DOTS.loop - 2 * step),
      ])),
    ]));
    runs.forEach(r => r.start());
    return () => runs.forEach(r => r.stop());
  }, [dots]);
  return (
    <View style={styles.typing} accessibilityLabel="typing">
      {dots.map((v, i) => (
        <Animated.View
          key={i}
          style={[styles.dot, {
            backgroundColor: color,
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [TYPING_DOTS.opacityFrom, TYPING_DOTS.opacityTo] }),
            transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -TYPING_DOTS.rise] }) }],
          }]}
        />
      ))}
    </View>
  );
}

function PlusIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 5v14M5 12h14" stroke={color} strokeWidth={2.6} strokeLinecap="round" />
    </Svg>
  );
}

interface RowProps {
  item: FriendActivity;
  myUserId: string;
  unread: number;
  theme: ResolvedTheme;
  sampleTyping: boolean;
  face: SampleFace | undefined;
  onPress: () => void;
  onPixPress: () => void;
  index: number;
}

function ChatRow({ item, myUserId, unread, theme, sampleTyping, face, onPress, onPixPress, index }: RowProps) {
  const typing = usePeerTyping(item.friend.userId) || sampleTyping;
  const pix = item.unopenedPix.length > 0;
  const dark = theme.mode === 'dark';
  const avatarLine = dark ? withAlpha(DARK_OVERLAY.avatarOutline.color, DARK_OVERLAY.avatarOutline.alpha) : theme.outline;
  const nameColor = dark ? withAlpha(DARK_OVERLAY.chatName.color, DARK_OVERLAY.chatName.alpha) : theme.ink;
  const count = pix ? item.unopenedPix.length : unread;
  const avatar = (
    <Avatar
      name={item.friend.username} size={48} radius={14} outline={avatarLine} ink={theme.onSecondary.ink}
      background={pix ? theme.pix : face?.color} emoji={face?.emoji} cropped={pix}
      peekOrder={index}
    />
  );
  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: theme.paper }]} onPress={onPress}>
      {pix ? <TouchableOpacity onPress={onPixPress} accessibilityLabel="Open pix">{avatar}</TouchableOpacity> : avatar}
      <View style={styles.rowMain}>
        <Text style={[styles.rowName, { color: nameColor }]} numberOfLines={1}>{item.friend.username}</Text>
        {typing ? <TypingDots color={theme.link} /> : (
          <View style={styles.previewLine}>
            <Text
              style={[styles.preview, { color: pix ? theme.pix : theme.muted }, pix && styles.previewPix]}
              numberOfLines={1}
            >
              {pix ? (count === 1 ? 'New pix' : `${count} new pix`) : activityPreview(item, myUserId).text}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.rowSide}>
        {item.latestAt > 0 && <Text style={[styles.time, { color: theme.muted }]}>{friendlyTime(item.latestAt)}</Text>}
        {count > 0 && (
          <View style={[styles.badge, { backgroundColor: pix ? theme.pix : theme.sun }]}>
            <Text style={[styles.badgeText, { color: pix ? theme.paper : theme.sunInk }]}>{count}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const SHEET_RADIUS = 26;

// claude: the board's vertical gesture. One drag feeds the search panel, the stories and the list, in that order
// going up and the reverse going down, so the list's own scrolling is off and this moves it. The fling is new: the
// board has a mouse, a phone needs momentum.
function usePullDown(searching: boolean, sky: string, paper: string) {
  const list = useAnimatedRef<FlatList<FriendActivity>>();
  const pull = useSharedValue(0);
  const collapse = useSharedValue(0);
  const listY = useSharedValue(0);
  const storiesH = useSharedValue(0);
  const contentH = useSharedValue(0);
  const viewH = useSharedValue(0);
  const isSearching = useSharedValue(false);
  const searchAmount = useSharedValue(0);
  const fling = useSharedValue(0);
  const flingSeen = useSharedValue(0);
  const flinging = useSharedValue(false);

  const setListY = (y: number) => {
    'worklet';
    listY.value = Math.min(Math.max(0, contentH.value - viewH.value), Math.max(0, y));
    scrollTo(list, 0, listY.value, false);
  };

  // claude: d > 0 moves content up (deeper into the list), d < 0 back toward the top
  const step = (d: number, canPull: boolean) => {
    'worklet';
    if (isSearching.value) {
      setListY(listY.value + d);
      return;
    }
    if (d > 0) {
      const fromPull = Math.min(d, pull.value);
      pull.value -= fromPull;
      const fromStories = Math.min(d - fromPull, storiesH.value - collapse.value);
      collapse.value += fromStories;
      setListY(listY.value + d - fromPull - fromStories);
      return;
    }
    const up = -d;
    const fromStories = Math.min(up, collapse.value);
    collapse.value -= fromStories;
    const fromList = Math.min(up - fromStories, listY.value);
    setListY(listY.value - fromList);
    if (canPull) pull.value = Math.min(PULL.max * PULL.travel, pull.value + up - fromStories - fromList);
  };

  const drag = usePanGesture({
    activeOffsetY: [-PULL.slop, PULL.slop],
    failOffsetX: [-PULL.slop, PULL.slop],
    onBegin: () => {
      'worklet';
      cancelAnimation(fling);
      flinging.value = false;
      cancelAnimation(pull);
      cancelAnimation(collapse);
    },
    onUpdate: e => {
      'worklet';
      step(-e.changeY, true);
    },
    onDeactivate: e => {
      'worklet';
      if (pull.value > 0 && !isSearching.value) {
        pull.value = withTiming(pull.value > PULL.max / 2 ? PULL.max : 0, TIMING.pullSettle);
        return;
      }
      flingSeen.value = 0;
      fling.value = 0;
      flinging.value = true;
      fling.value = withDecay({ velocity: e.velocityY }, () => { flinging.value = false; });
    },
  });

  useAnimatedReaction(() => fling.value, now => {
    if (!flinging.value) return;
    const moved = now - flingSeen.value;
    flingSeen.value = now;
    step(-moved, false);
  });
  // claude: a filter can shorten the list under the current scroll position
  useAnimatedReaction(() => Math.max(0, contentH.value - viewH.value), most => {
    if (listY.value > most) setListY(most);
  });

  const wasSearching = useRef(false);
  useEffect(() => {
    if (searching === wasSearching.current) return;
    wasSearching.current = searching;
    isSearching.value = searching;
    searchAmount.value = withTiming(searching ? 1 : 0, TIMING.pullSettle);
    // claude: clearing the text ends the search but keeps the panel open
    pull.value = withTiming(PULL.max, TIMING.pullSettle);
    collapse.value = withTiming(searching ? storiesH.value : 0, TIMING.pullSettle);
  }, [searching, isSearching, searchAmount, pull, collapse, storiesH]);

  const collapsed = () => {
    'worklet';
    return storiesH.value > 0 ? Math.min(1, Math.max(0, collapse.value / storiesH.value)) : 0;
  };
  const screenStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(collapsed() * (1 - searchAmount.value), [0, 1], [sky, paper]),
  }));
  const panelStyle = useAnimatedStyle(() => {
    const p = Math.max(0, pull.value);
    return { height: p > PULL.max ? PULL.max + (p - PULL.max) * RUBBER_BAND.pull : p };
  });
  const storiesStyle = useAnimatedStyle(() => ({ marginTop: -collapse.value, opacity: 1 - collapsed() }));
  const sheetStyle = useAnimatedStyle(() => {
    const r = SHEET_RADIUS * (1 - collapsed() * (1 - searchAmount.value));
    return { borderTopLeftRadius: r, borderTopRightRadius: r };
  });

  return {
    list,
    drag,
    screenStyle,
    panelStyle,
    storiesStyle,
    sheetStyle,
    onStoriesHeight: (h: number) => { if (h > 0) storiesH.value = h; },
    onContentHeight: (h: number) => { contentH.value = h; },
    onViewHeight: (h: number) => { viewH.value = h; },
  };
}

export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const myEmoji = useUi2(s => s.emoji);
  const myColor = useUi2(s => s.color);
  const on = theme.onSecondary;
  const insets = useSafeAreaInsets();
  const { sample, myUserId, identity, friends, items, stories, typingUserId, faces } = useChatsData();

  // claude: chats holding unopened photos sort first, then most recent.
  const activities = useMemo(
    () => friendActivities(friends, myUserId, items)
      .sort((a, b) => Number(b.unopenedPix.length > 0) - Number(a.unopenedPix.length > 0)),
    [friends, myUserId, items],
  );
  const { mine, others } = useMemo(() => storyGroups(stories, identity), [stories, identity]);

  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () => (needle === '' ? activities : activities.filter(
      a => `${a.friend.username} ${activityPreview(a, myUserId).text}`.toLowerCase().includes(needle),
    )),
    [activities, needle, myUserId],
  );
  const pullDown = usePullDown(needle !== '', theme.sky, theme.paper);

  const unreadFrom = (userId: string) => conversationItems(items, userId)
    .filter(m => m.kind === 'message' && m.authorUserId !== myUserId && m.viewedAt === null).length;

  const story = (key: string, label: string, username: string, mineBadge: boolean, onPress: () => void) => (
    <TouchableOpacity key={key} style={styles.story} onPress={onPress}>
      <View>
        <Avatar
          name={username} size={54} radius={14} outline={on.outline} ink={on.ink}
          emoji={mineBadge ? myEmoji : faces[key]?.emoji} background={(mineBadge ? myColor : faces[key]?.color) || undefined}
        />
        {mineBadge && (
          <View style={[styles.storyAdd, { backgroundColor: on.sun, borderColor: on.outline }]}>
            <PlusIcon size={12} color={on.ink} />
          </View>
        )}
      </View>
      <Text style={[styles.storyName, { color: on.ink }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );

  // claude: sample stories and pix have no media, so the real viewers never open on sample ids.
  const openStories = (userId: string) => {
    if (!sample) nav.navigate('StoryViewer', { mode: 'stories', initialUserId: userId });
  };

  return (
    <GestureDetector gesture={pullDown.drag}>
    <Reanimated.View style={[styles.screen, { paddingTop: insets.top }, pullDown.screenStyle]}>
      <Reanimated.View style={[styles.panel, pullDown.panelStyle]}>
        <View style={styles.panelInner}>
          <TouchableOpacity
            style={[styles.newBtn, { backgroundColor: on.sun, borderColor: on.outline }]}
            onPress={() => nav.navigate('AddFriend')}
            accessibilityLabel="New chat, group or friend"
          >
            <PlusIcon size={20} color={on.ink} />
          </TouchableOpacity>
          <View style={[styles.field, { backgroundColor: on.paper, borderColor: on.outline }]}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Circle cx="11" cy="11" r="7" stroke={on.inkSoft} strokeWidth={2.4} />
              <Path d="M20 20l-4-4" stroke={on.inkSoft} strokeWidth={2.4} strokeLinecap="round" />
            </Svg>
            <TextInput
              style={[styles.searchInput, { color: on.ink }]}
              placeholder="Search chats and friends"
              placeholderTextColor={on.muted}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              returnKeyType="search"
            />
          </View>
        </View>
      </Reanimated.View>
      <Reanimated.View style={pullDown.storiesStyle} onLayout={e => pullDown.onStoriesHeight(e.nativeEvent.layout.height)}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storiesScroll} contentContainerStyle={styles.stories}>
          {story('mine', 'Your story', mine.username, true, () => (
            mine.stories.length === 0 ? nav.navigate('MainTabs', { screen: 'Camera' }) : openStories(mine.userId)
          ))}
          {others.map(g => story(g.userId, g.username, g.username, false, () => openStories(g.userId)))}
        </ScrollView>
      </Reanimated.View>
      <Reanimated.FlatList
        ref={pullDown.list}
        style={[styles.sheet, { backgroundColor: theme.paper }, pullDown.sheetStyle]}
        contentContainerStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 100 }]}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onLayout={e => pullDown.onViewHeight(e.nativeEvent.layout.height)}
        onContentSizeChange={(_, h) => pullDown.onContentHeight(h)}
        ListEmptyComponent={needle === '' ? undefined : (
          <Text style={[styles.noResults, { color: theme.muted }]}>{`No chats match “${query.trim()}”`}</Text>
        )}
        data={shown}
        keyExtractor={a => a.friend.userId}
        renderItem={({ item, index }) => {
          const openChat = () => nav.navigate('Chat', { userId: item.friend.userId, username: item.friend.username });
          return (
            <ChatRow
              item={item}
              index={index}
              myUserId={myUserId}
              unread={unreadFrom(item.friend.userId)}
              theme={theme}
              sampleTyping={item.friend.userId === typingUserId}
              face={faces[item.friend.userId]}
              onPress={openChat}
              onPixPress={() => (sample ? openChat() : openPixViewer(nav, item.friend, item.unopenedPix))}
            />
          );
        }}
      />
    </Reanimated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  panel: { overflow: 'hidden' },
  panelInner: { flexDirection: 'row', alignItems: 'center', gap: 10, height: PULL.max, paddingTop: 4, paddingBottom: 12, paddingHorizontal: 16 },
  newBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, height: 40, borderRadius: 999, borderWidth: 2, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, fontSize: 13, fontFamily: FONT[700], paddingVertical: 0 },
  noResults: { paddingVertical: 30, paddingHorizontal: 16, textAlign: 'center', fontSize: 13, fontFamily: FONT[800] },
  storiesScroll: { flexGrow: 0 },
  stories: { gap: 12, paddingTop: 8, paddingBottom: 18, paddingHorizontal: 16 },
  story: { width: 58, alignItems: 'center', gap: 6 },
  storyAdd: {
    position: 'absolute', right: -6, bottom: -6, width: 22, height: 22, borderRadius: 11, borderWidth: 2.5,
    alignItems: 'center', justifyContent: 'center',
  },
  storyName: { fontSize: 11, fontFamily: FONT[800], maxWidth: '100%' },
  sheet: { flex: 1, borderTopLeftRadius: SHEET_RADIUS, borderTopRightRadius: SHEET_RADIUS, overflow: 'hidden' },
  sheetContent: { paddingTop: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 16 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 15, fontFamily: FONT[900] },
  previewLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  preview: { flexShrink: 1, fontSize: 13, fontFamily: FONT[600] },
  previewPix: { fontFamily: FONT[800] },
  rowSide: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontSize: 11, fontFamily: FONT[700], fontVariant: ['tabular-nums'] },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 11, fontFamily: FONT[900], fontVariant: ['tabular-nums'] },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
