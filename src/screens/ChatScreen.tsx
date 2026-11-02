import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated, StyleSheet, type ViewToken,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { conversationEntries } from '../domain/chats';
import { conversationId } from '../domain/conversation';
import { pixStatus } from '../domain/pix';
import type { ScreenEntry } from '../domain/seen';
import { useSession, useModelEntries, useAcceptedFriends, saveEntry, markSeen } from '../state/store';
import { useAppActive } from '../hooks/useAppActive';
import { errorMessage, logError } from '../utils/log';
import type { ModelData } from '../models/schema';
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

type TimelineItem =
  | (ScreenEntry<ModelData<'directMessage'>> & { kind: 'message' })
  | (ScreenEntry<ModelData<'pix'>> & { kind: 'pix' });

const VIEWABILITY = { itemVisiblePercentThreshold: 50 };

export function ChatScreen({ route }: RootStackScreenProps<'Chat'>) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId } = useSession();
  const friends = useAcceptedFriends();
  const friend = friends.find((f) => f.userId === route.params.friend.userId) ?? route.params.friend;
  const headerHeight = useHeaderHeight();
  const allMessages = useModelEntries('directMessage');
  const allPix = useModelEntries('pix');
  const [text, setText] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const listRef = useRef<FlatList<TimelineItem>>(null);
  const prevCountRef = useRef(0);
  const convId = conversationId(myUserId, friend.userId);

  const messages = useMemo(() => conversationEntries(allMessages, convId), [allMessages, convId]);
  const timeline: TimelineItem[] = useMemo(() => [
    ...messages.map((m) => ({ ...m, kind: 'message' as const })),
    ...conversationEntries(allPix, convId).map((p) => ({ ...p, kind: 'pix' as const })),
  ].sort((a, b) => a.sentAt - b.sentAt), [messages, allPix, convId]);

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
      markSeen('directMessage', m).catch((e) => logError('seen.message:' + m.id, e));
    }
  }, [isFocused, appActive, visibleIds, messages, myUserId]);

  useEffect(() => {
    const unsubscribe = onObscuraEvent((event) => {
      if (event.type === 'messageReceived' && event.model === 'directMessage') {
        setPeerTyping(false);
      } else if (event.type === 'typingChanged' && event.conversationId === convId) {
        // Anyone can signal under this id; only this conversation's friend counts.
        setPeerTyping(event.userIds.includes(friend.userId));
      }
    });
    Obscura.observeTyping(convId).catch((e) => logError('typing.observe', e));
    return () => {
      unsubscribe();
      Obscura.stopObservingTyping(convId).catch((e) => logError('typing.unobserve', e));
    };
  }, [convId, friend.userId]);

  const send = async () => {
    if (!text.trim()) return;
    const content = text;
    setText('');
    try {
      await Obscura.stopTyping([friend.userId], convId);
      await saveEntry('directMessage', { conversationId: convId, content });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onChangeText = (t: string) => {
    setText(t);
    if (t.length > 0) Obscura.sendTyping([friend.userId], convId).catch((e) => logError('typing.send', e));
  };

  const renderItem = ({ item }: { item: TimelineItem }) => {
    if (item.kind === 'message') {
      const mine = item.authorUserId === myUserId;
      return (
        <View style={[cs.msgRow, mine ? cs.msgRowRight : cs.msgRowLeft]}>
          <View style={[cs.msgBubble, mine ? cs.myBubble : cs.theirBubble]}>
            <Text style={mine ? cs.myBubbleText : cs.theirBubbleText}>{item.data.content}</Text>
          </View>
        </View>
      );
    }
    switch (pixStatus(item, myUserId)) {
      case 'received_new':
        return (
          <View style={[cs.msgRow, cs.msgRowLeft]}>
            <TouchableOpacity style={cs.pixBarFilled} onPress={() => openPixViewer(nav, friend, [item])}>
              <Text style={cs.pixBarFilledText}>
                {item.data.caption ? `New pix: ${item.data.caption}` : 'New pix · Tap to view'}
              </Text>
            </TouchableOpacity>
          </View>
        );
      case 'received_viewed':
        return (
          <View style={[cs.msgRow, cs.msgRowLeft]}>
            <View style={cs.pixBarViewed}>
              <Text style={cs.pixBarViewedText}>{item.data.caption || 'Pix viewed'}</Text>
            </View>
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
    <SafeAreaView style={s.container} edges={['bottom']}>
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        <FlatList
          ref={listRef}
          data={timeline}
          keyExtractor={(item) => item.id}
          style={cs.messageList}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={renderItem}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY}
          onContentSizeChange={() => {
            if (timeline.length > prevCountRef.current) {
              listRef.current?.scrollToEnd({ animated: prevCountRef.current > 0 });
            }
            prevCountRef.current = timeline.length;
          }}
          ListEmptyComponent={
            <View style={cs.emptyWrap}>
              <Text style={cs.emptyText}>
                Messages and pix with {friend.username} are end-to-end encrypted and disappear after they are seen.
              </Text>
            </View>
          }
          ListFooterComponent={peerTyping ? (
            <View style={[cs.msgRow, cs.msgRowLeft]}>
              <TypingBubble />
            </View>
          ) : null}
        />

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
  messageList: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
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
  pixBarViewed: {
    borderWidth: 1.5, borderColor: colors.surfaceMuted, borderStyle: 'dashed', borderRadius: 16,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  pixBarViewedText: { color: colors.textSecondary, fontWeight: '600', fontSize: 14 },
  pixSentPill: {
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  pixSentText: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  emptyWrap: { paddingHorizontal: 32, paddingTop: 48, alignItems: 'center' },
  emptyText: { color: colors.textDim, fontSize: 13, textAlign: 'center', lineHeight: 19 },
});
