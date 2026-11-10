import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View,
  type ListViewToken,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  chatTimeline, conversationItems, pixStatus, unseenVisibleMessageIds, type ChatTimelineItem,
} from '../../domain/chats';
import { markSeen } from '../../state/store';
import { notifyTyping, sendChatMessage, usePeerTyping } from '../../state/chat';
import { toast } from '../../state/toast';
import { useAppActive } from '../../hooks/useAppActive';
import { errorMessage, logError } from '../../utils/log';
import { openPixViewer } from '../../navigation/openPixViewer';
import type { RootStackParamList, RootStackScreenProps } from '../../navigation/types';
import { DARK_OVERLAY, withAlpha } from '../theme';
import { useUi2Theme } from '../store';
import { TIMING } from '../motion';
import { sendSampleMessage, useChatsData } from '../chatsData';
import { avatarColor } from '../components/Avatar';
import { TypingDots } from './ChatListScreen';

const VIEWABILITY = { itemVisiblePercentThreshold: 50 };
const PEEK = 100;
const PEEK_SHOW = 72;

const PIX_LABEL = {
  received_new: 'New pix · Tap to view',
  sent_pending: 'Pix delivered',
  sent_opened: 'Pix opened',
} as const;

const overlay = (o: { color: string; alpha: number }) => withAlpha(o.color, o.alpha);

export function ChatScreen({ route }: RootStackScreenProps<'Chat'>) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const on = theme.onSecondary;
  const dark = theme.mode === 'dark';
  const insets = useSafeAreaInsets();
  const { sample, myUserId, friends, items: allItems, typingUserId, faces } = useChatsData();
  const friend = friends.find(f => f.userId === route.params.userId)
    ?? { userId: route.params.userId, username: route.params.username, status: 'accepted' as const };
  const face = faces[friend.userId];
  const friendColor = face?.color ?? avatarColor(friend.username);
  const peerTyping = usePeerTyping(friend.userId) || friend.userId === typingUserId;
  const [text, setText] = useState('');

  // claude: starts hidden behind the chat panel (the header clips it) and rises once the screen has finished opening
  const peekY = useSharedValue(PEEK_SHOW + 8);
  const peekStyle = useAnimatedStyle(() => ({ transform: [{ translateY: peekY.value }] }));
  useEffect(() => nav.addListener('transitionEnd', e => {
    if (!e.data.closing) peekY.value = withTiming(0, TIMING.faceSlide);
  }), [nav, peekY]);

  const peerItems = useMemo(() => conversationItems(allItems, friend.userId), [allItems, friend.userId]);
  const messages = useMemo(() => peerItems.filter(i => i.kind === 'message'), [peerItems]);
  const unopenedPix = useMemo(
    () => peerItems.filter(p => p.kind === 'pix' && pixStatus(p, myUserId) === 'received_new'),
    [peerItems, myUserId],
  );
  const timeline = useMemo(
    () => [...chatTimeline(allItems, friend.userId, myUserId)].reverse(),
    [allItems, friend.userId, myUserId],
  );

  // claude: same seen rule as the current chat: on screen, chat focused, app in the foreground.
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    setVisibleIds(new Set(viewableItems.map(v => (v.item as ChatTimelineItem).id)));
  }).current;
  const marked = useRef(new Set<string>());
  useEffect(() => {
    if (sample || !isFocused || !appActive) return;
    for (const id of unseenVisibleMessageIds(messages, visibleIds, myUserId, marked.current)) {
      marked.current.add(id);
      markSeen(id).catch(e => {
        marked.current.delete(id);
        logError('seen.message:' + id, e);
      });
    }
  }, [sample, isFocused, appActive, visibleIds, messages, myUserId]);

  const send = async () => {
    if (!text.trim()) return;
    const content = text;
    setText('');
    if (sample) {
      sendSampleMessage(friend.userId, myUserId, content);
      return;
    }
    try {
      await sendChatMessage(friend.userId, content);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onChangeText = (t: string) => {
    if (!sample) notifyTyping(friend.userId, text, t);
    setText(t);
  };

  const inBubble = { backgroundColor: dark ? overlay(DARK_OVERLAY.incomingBubble) : theme.paper };
  const outBubble = { backgroundColor: friendColor };

  const renderItem = ({ item }: { item: ChatTimelineItem }) => {
    const mine = item.authorUserId === myUserId;
    const bubble = [styles.msg, mine ? styles.out : styles.in, mine ? outBubble : inBubble];
    const textStyle = [styles.msgText, { color: mine ? theme.sunInk : theme.ink }];
    if (item.kind === 'message') {
      return (
        <View style={mine ? styles.fromMe : styles.fromThem}>
          <View style={bubble}><Text style={textStyle}>{item.content}</Text></View>
        </View>
      );
    }
    if (item.status === 'received_new') {
      return (
        <View style={styles.fromThem}>
          <TouchableOpacity style={[bubble, { backgroundColor: theme.pix }]} onPress={() => { if (!sample) openPixViewer(nav, friend, unopenedPix); }}>
            <Text style={[styles.msgText, { color: theme.paper }]}>{PIX_LABEL.received_new}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.fromMe}>
        <View style={bubble}><Text style={textStyle}>{PIX_LABEL[item.status]}</Text></View>
      </View>
    );
  };

  const fieldLine = dark ? overlay(DARK_OVERLAY.messageOutline) : theme.outline;
  const fieldText = dark ? overlay(DARK_OVERLAY.messageText) : theme.ink;
  const plusLine = dark ? overlay(DARK_OVERLAY.plusButton) : theme.outline;
  const plusInk = dark ? overlay(DARK_OVERLAY.plusButton) : theme.ink;

  return (
    <View style={[styles.screen, { backgroundColor: friendColor }]}>
      <View style={[styles.head, { paddingTop: insets.top }]}>
        <Animated.View pointerEvents="none" style={[styles.peek, peekStyle]}>
          <Text style={[styles.peekFace, { color: on.ink }]}>{face?.emoji ?? friend.username[0]?.toUpperCase() ?? '?'}</Text>
        </Animated.View>
        <TouchableOpacity style={styles.iconBtn} onPress={() => nav.goBack()} accessibilityLabel="Back">
          <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
            <Path d="M15 5l-7 7 7 7" stroke={on.ink} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </TouchableOpacity>
        <View style={styles.who}><Text style={[styles.whoText, { color: on.ink }]} numberOfLines={1}>{friend.username}</Text></View>
        <TouchableOpacity style={styles.iconBtn} accessibilityLabel="More">
          <Svg width={24} height={24} viewBox="0 0 24 24">
            <Circle cx="12" cy="5" r="2" fill={on.ink} />
            <Circle cx="12" cy="12" r="2" fill={on.ink} />
            <Circle cx="12" cy="19" r="2" fill={on.ink} />
          </Svg>
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <View style={[styles.thread, { backgroundColor: withAlpha(theme.shadeWhite, 82) }]}>
          <FlatList
            inverted
            data={timeline}
            keyExtractor={i => i.id}
            renderItem={renderItem}
            contentContainerStyle={[styles.lines, { paddingTop: 90 + insets.bottom }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={VIEWABILITY}
            ListHeaderComponent={peerTyping ? (
              <View style={styles.fromThem}>
                <View style={[styles.msg, styles.in, inBubble, styles.typingBubble]}><TypingDots color={theme.link} /></View>
              </View>
            ) : undefined}
          />
        </View>

        <View style={[styles.composer, { paddingBottom: 18 + insets.bottom }]}>
          <View style={[styles.round, { borderColor: plusLine }]}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path d="M12 5v14M5 12h14" stroke={plusInk} strokeWidth={2.6} strokeLinecap="round" />
            </Svg>
          </View>
          <View
            style={[
              styles.field,
              { borderColor: fieldLine, backgroundColor: dark ? overlay(DARK_OVERLAY.messageBackground) : theme.paper },
            ]}
          >
            <TextInput
              style={[styles.input, { color: fieldText }]}
              placeholder="Message…"
              placeholderTextColor={dark ? fieldText : theme.muted}
              value={text}
              onChangeText={onChangeText}
              returnKeyType="send"
              submitBehavior="submit"
              onSubmitEditing={send}
            />
          </View>
          <View style={[styles.round, { backgroundColor: theme.yellow, borderColor: theme.yellow }]}>
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Rect x="9" y="3" width="6" height="11" rx="3" fill={theme.sunInk} stroke={theme.sunInk} strokeWidth={2.2} />
              <Path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke={theme.sunInk} strokeWidth={2.2} strokeLinecap="round" />
            </Svg>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // claude: overflow clips the peeking friend at the panel's top edge
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingBottom: 34, overflow: 'hidden',
  },
  // claude: twice as wide as the face, so a wide emoji is never wrapped; still centered on 71%
  peek: {
    position: 'absolute', left: '71%', marginLeft: -PEEK, bottom: PEEK_SHOW - PEEK, width: PEEK * 2, height: PEEK,
    alignItems: 'center', justifyContent: 'center',
  },
  peekFace: { fontSize: PEEK, lineHeight: PEEK * 1.15, fontWeight: '900', includeFontPadding: false },
  iconBtn: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  who: { flex: 1, minHeight: 36, justifyContent: 'center' },
  whoText: { fontSize: 17, fontWeight: '900' },
  body: { flex: 1 },
  thread: { flex: 1, borderTopLeftRadius: 26, borderTopRightRadius: 26, overflow: 'hidden' },
  // claude: inverted list, so flex-end keeps a short thread at the top of the panel
  lines: { flexGrow: 1, justifyContent: 'flex-end', gap: 10, paddingHorizontal: 14, paddingBottom: 18 },
  fromThem: { flexDirection: 'row', justifyContent: 'flex-start' },
  fromMe: { flexDirection: 'row', justifyContent: 'flex-end' },
  msg: { maxWidth: '78%', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 16 },
  in: { borderBottomLeftRadius: 6 },
  out: { borderBottomRightRadius: 6 },
  msgText: { fontSize: 13, fontWeight: '700', lineHeight: 17.5 },
  typingBubble: { paddingVertical: 12 },
  composer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 10, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  field: {
    flex: 1, height: 40, borderRadius: 999, borderWidth: 2, flexDirection: 'row', alignItems: 'center',
    gap: 8, paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 13, fontWeight: '700', paddingVertical: 0 },
  round: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
