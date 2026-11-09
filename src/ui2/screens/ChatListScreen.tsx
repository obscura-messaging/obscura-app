import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated, FlatList, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activityPreview, conversationItems, friendActivities, type FriendActivity } from '../../domain/chats';
import { storyGroups } from '../../domain/viewer';
import { useAcceptedFriends, useIdentity, useMessages, useSession, useStories } from '../../state/store';
import { usePeerTyping } from '../../state/chat';
import { openPixViewer } from '../../navigation/openPixViewer';
import type { RootStackParamList } from '../../navigation/types';
import { DARK_OVERLAY, withAlpha, type ResolvedTheme } from '../theme';
import { useUi2, useUi2Theme } from '../store';
import { TYPING_DOTS } from '../motion';
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

function PhotoIcon({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="4" width="18" height="16" rx="3" stroke={color} strokeWidth={2.2} />
      <Circle cx="9" cy="10" r="1.8" fill={color} />
      <Path d="M21 16l-5-5-8 9" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

interface RowProps {
  item: FriendActivity;
  myUserId: string;
  unread: number;
  theme: ResolvedTheme;
  onPress: () => void;
}

function ChatRow({ item, myUserId, unread, theme, onPress }: RowProps) {
  const typing = usePeerTyping(item.friend.userId);
  const pix = item.unopenedPix.length > 0;
  const dark = theme.mode === 'dark';
  const avatarLine = dark ? withAlpha(DARK_OVERLAY.avatarOutline.color, DARK_OVERLAY.avatarOutline.alpha) : theme.outline;
  const nameColor = dark ? withAlpha(DARK_OVERLAY.chatName.color, DARK_OVERLAY.chatName.alpha) : theme.ink;
  const count = pix ? item.unopenedPix.length : unread;
  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: theme.paper }]} onPress={onPress}>
      <Avatar
        name={item.friend.username} size={48} radius={14} outline={avatarLine} ink={theme.onSecondary.ink}
        background={pix ? theme.pix : undefined} cropped={pix}
      />
      <View style={styles.rowMain}>
        <Text style={[styles.rowName, { color: nameColor }]} numberOfLines={1}>{item.friend.username}</Text>
        {typing ? <TypingDots color={theme.link} /> : (
          <View style={styles.previewLine}>
            {pix && <PhotoIcon color={theme.pix} />}
            <Text
              style={[styles.preview, { color: pix ? theme.pix : theme.muted }, pix && styles.previewPix]}
              numberOfLines={1}
            >
              {activityPreview(item, myUserId).text}
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

export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const myEmoji = useUi2(s => s.emoji);
  const myColor = useUi2(s => s.color);
  const on = theme.onSecondary;
  const insets = useSafeAreaInsets();
  const { myUserId } = useSession();
  const identity = useIdentity();
  const friends = useAcceptedFriends();
  const items = useMessages();
  const stories = useStories();

  // claude: chats holding unopened photos sort first, then most recent.
  const activities = useMemo(
    () => friendActivities(friends, myUserId, items)
      .sort((a, b) => Number(b.unopenedPix.length > 0) - Number(a.unopenedPix.length > 0)),
    [friends, myUserId, items],
  );
  const { mine, others } = useMemo(() => storyGroups(stories, identity), [stories, identity]);

  const unreadFrom = (userId: string) => conversationItems(items, userId)
    .filter(m => m.kind === 'message' && m.authorUserId !== myUserId && m.viewedAt === null).length;

  const story = (key: string, label: string, username: string, mineBadge: boolean, onPress: () => void) => (
    <TouchableOpacity key={key} style={styles.story} onPress={onPress}>
      <View>
        <Avatar
          name={username} size={54} radius={14} outline={on.outline} ink={on.ink}
          emoji={mineBadge ? myEmoji : null} background={(mineBadge && myColor) || undefined}
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

  const openStories = (userId: string) => nav.navigate('StoryViewer', { mode: 'stories', initialUserId: userId });

  return (
    <View style={[styles.screen, { backgroundColor: theme.sky, paddingTop: insets.top }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.storiesScroll} contentContainerStyle={styles.stories}>
        {story('mine', 'Your story', mine.username, true, () => (
          mine.stories.length === 0 ? nav.navigate('MainTabs', { screen: 'Camera' }) : openStories(mine.userId)
        ))}
        {others.map(g => story(g.userId, g.username, g.username, false, () => openStories(g.userId)))}
      </ScrollView>
      <FlatList
        style={[styles.sheet, { backgroundColor: theme.paper }]}
        contentContainerStyle={[styles.sheetContent, { paddingBottom: insets.bottom + 100 }]}
        data={activities}
        keyExtractor={a => a.friend.userId}
        renderItem={({ item }) => (
          <ChatRow
            item={item}
            myUserId={myUserId}
            unread={unreadFrom(item.friend.userId)}
            theme={theme}
            onPress={() => (item.unopenedPix.length > 0
              ? openPixViewer(nav, item.friend, item.unopenedPix)
              : nav.navigate('Chat', { userId: item.friend.userId, username: item.friend.username }))}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  storiesScroll: { flexGrow: 0 },
  stories: { gap: 12, paddingTop: 8, paddingBottom: 18, paddingHorizontal: 16 },
  story: { width: 58, alignItems: 'center', gap: 6 },
  storyAdd: {
    position: 'absolute', right: -6, bottom: -6, width: 22, height: 22, borderRadius: 11, borderWidth: 2.5,
    alignItems: 'center', justifyContent: 'center',
  },
  storyName: { fontSize: 11, fontWeight: '800', maxWidth: '100%' },
  sheet: { flex: 1, borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' },
  sheetContent: { paddingTop: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 16 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 15, fontWeight: '900' },
  previewLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  preview: { flexShrink: 1, fontSize: 13, fontWeight: '600' },
  previewPix: { fontWeight: '800' },
  rowSide: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
