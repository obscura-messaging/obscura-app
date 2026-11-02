import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated, PanResponder, StyleSheet, type ViewToken,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  chatTimeline, conversationItems, pixStatus, type ChatTimelineItem,
} from '../domain/chats';
import { useSession, useMessages, useAcceptedFriends, markSeen } from '../state/store';
import { usePeerTyping, notifyTyping, sendChatMessage } from '../state/chat';
import { useAppActive } from '../hooks/useAppActive';
import { isBackSwipeGesture, shouldCompleteBackSwipe } from '../utils/gesture';
import { errorMessage, logError } from '../utils/log';
import { toast } from '../components/Toast';
import { SendIcon } from '../components/icons';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { s, colors } from '../styles';

const DOT_STEP_MS = 200;

function TypingBubble() {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    const loops = dots.map((dot, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * DOT_STEP_MS),
      Animated.timing(dot, { toValue: 1, duration: 2 * DOT_STEP_MS, useNativeDriver: true }),
      Animated.timing(dot, { toValue: 0.3, duration: 2 * DOT_STEP_MS, useNativeDriver: true }),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);

  return (
    <View style={cs.typingBubble}>
      {dots.map((opacity, i) => <Animated.View key={i} style={[cs.typingDot, { opacity }]} />)}
    </View>
  );
}

type TimelineItem = ChatTimelineItem;

const VIEWABILITY = { itemVisiblePercentThreshold: 50 };

export function ChatScreen({ route }: RootStackScreenProps<'Chat'>) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId } = useSession();
  const friends = useAcceptedFriends();
  const friend = friends.find((f) => f.userId === route.params.userId)
    ?? { userId: route.params.userId, username: route.params.username, status: 'accepted' as const };
  const headerHeight = useHeaderHeight();
  const allItems = useMessages();
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<TimelineItem>>(null);
  const prevCountRef = useRef(0);
  const peerTyping = usePeerTyping(friend.userId);

  const peerItems = useMemo(() => conversationItems(allItems, friend.userId), [allItems, friend.userId]);
  const messages = useMemo(() => peerItems.filter((item) => item.kind === 'message'), [peerItems]);
  const unopenedPix = useMemo(
    () => peerItems.filter((p) => p.kind === 'pix' && pixStatus(p, myUserId) === 'received_new'),
    [peerItems, myUserId],
  );
  const timeline = useMemo(
    () => chatTimeline(allItems, friend.userId, myUserId),
    [allItems, friend.userId, myUserId],
  );
  // Inverted FlatList renders index 0 at the visual bottom (above the composer), so newest is first.
  const invertedTimeline = useMemo(() => [...timeline].reverse(), [timeline]);

  useEffect(() => {
    if (timeline.length > prevCountRef.current && prevCountRef.current > 0) {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    }
    prevCountRef.current = timeline.length;
  }, [timeline.length]);

  // Android native-stack fragments do not support interactive swipe-back; handle right-swipes directly.
  const backSwipe = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: (_e, gs) =>
        Platform.OS === 'android' && isBackSwipeGesture(gs.dx, gs.dy),
      onPanResponderRelease: (_e, gs) => {
        if (shouldCompleteBackSwipe(gs.dx, gs.vx)) nav.goBack();
      },
    }),
  ).current;

  // A received message is seen once it is on screen in the focused chat with the app foregrounded.
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    setVisibleIds(new Set(viewableItems.map((v) => (v.item as TimelineItem).id)));
  }).current;
  const marked = useRef(new Set<string>());
  useEffect(() => {
    if (!isFocused || !appActive) return;
    for (const m of messages) {
      if (!visibleIds.has(m.id) || m.viewedAt !== null || m.authorUserId === myUserId) continue;
      if (marked.current.has(m.id)) continue;
      marked.current.add(m.id);
      markSeen(m.id).catch((e) => {
        marked.current.delete(m.id);
        logError('seen.message:' + m.id, e);
      });
    }
  }, [isFocused, appActive, visibleIds, messages, myUserId]);

  const send = async () => {
    if (!text.trim()) return;
    const content = text;
    setText('');
    try {
      await sendChatMessage(friend.userId, content);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onChangeText = (t: string) => {
    notifyTyping(friend.userId, text, t);
    setText(t);
  };

  const renderItem = ({ item }: { item: TimelineItem }) => {
    if (item.kind === 'message') {
      const mine = item.authorUserId === myUserId;
      return (
        <View style={[cs.msgRow, mine ? cs.msgRowRight : cs.msgRowLeft]}>
          <View style={[cs.msgBubble, mine ? cs.myBubble : cs.theirBubble]}>
            <Text style={mine ? cs.myBubbleText : cs.theirBubbleText}>{item.content}</Text>
          </View>
        </View>
      );
    }
    switch (item.status) {
      case 'received_new':
        return (
          <View style={[cs.msgRow, cs.msgRowLeft]}>
            <TouchableOpacity style={cs.pixBarFilled} onPress={() => openPixViewer(nav, friend, unopenedPix)}>
              <Text style={cs.pixBarFilledText}>New pix · Tap to view</Text>
            </TouchableOpacity>
          </View>
        );
      case 'sent_pending':
        return (
          <View style={[cs.msgRow, cs.msgRowRight]}>
            <View style={cs.pixSentPill}>
              <Text style={cs.pixSentText}>Pix delivered</Text>
            </View>
          </View>
        );
      case 'sent_opened':
        return (
          <View style={[cs.msgRow, cs.msgRowRight]}>
            <View style={cs.pixSentPill}>
              <Text style={cs.pixSentText}>Pix opened</Text>
            </View>
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={s.container} edges={['bottom']} {...backSwipe.panHandlers}>
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        {invertedTimeline.length === 0 ? (
          <View style={cs.emptyContainer}>
            <View style={cs.emptyWrap}>
              <Text style={cs.emptyText}>
                Messages and pix with {friend.username} are end-to-end encrypted and disappear after they are seen.
              </Text>
            </View>
            {peerTyping && (
              <View style={[cs.msgRow, cs.msgRowLeft]}>
                <TypingBubble />
              </View>
            )}
          </View>
        ) : (
          <FlatList
            ref={listRef}
            inverted
            data={invertedTimeline}
            keyExtractor={(item) => item.id}
            style={cs.messageList}
            contentContainerStyle={cs.listContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderItem={renderItem}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={VIEWABILITY}
            // In an inverted FlatList, ListHeaderComponent renders at the visual bottom (offset 0).
            ListHeaderComponent={peerTyping ? (
              <View style={[cs.msgRow, cs.msgRowLeft]}>
                <TypingBubble />
              </View>
            ) : null}
          />
        )}

        <View style={cs.composer}>
          <TextInput style={cs.composerInput} placeholder="Message" placeholderTextColor={colors.textDim}
            value={text} onChangeText={onChangeText} />
          <TouchableOpacity
            style={[cs.sendBtn, !text.trim() && s.btnDisabled]}
            onPress={send}
            disabled={!text.trim()}
          >
            <SendIcon size={20} color={colors.onAccent} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const cs = StyleSheet.create({
  messageList: { flex: 1, paddingHorizontal: 12 },
  // In an inverted FlatList, flex-end aligns short conversations to the visual top of the screen.
  listContent: { flexGrow: 1, justifyContent: 'flex-end', paddingVertical: 8 },
  emptyContainer: { flex: 1, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'space-between' },
  msgRow: { marginVertical: 3 },
  msgRowRight: { alignItems: 'flex-end' },
  msgRowLeft: { alignItems: 'flex-start' },
  msgBubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, maxWidth: '78%' },
  myBubble: { backgroundColor: colors.accent },
  theirBubble: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  myBubbleText: { color: colors.onAccent, fontSize: 16 },
  theirBubbleText: { color: colors.text, fontSize: 16 },
  typingBubble: {
    flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 18,
    paddingHorizontal: 14, paddingVertical: 10, gap: 4, marginVertical: 2,
  },
  typingDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim,
  },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  composerInput: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: colors.text, fontSize: 16,
    borderWidth: 1, borderColor: colors.border,
  },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  pixBarFilled: {
    backgroundColor: colors.accent, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12,
  },
  pixBarFilledText: { color: colors.onAccent, fontWeight: '700', fontSize: 15 },
  pixSentPill: {
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  pixSentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  emptyWrap: { paddingHorizontal: 32, paddingTop: 48, alignItems: 'center' },
  emptyText: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
