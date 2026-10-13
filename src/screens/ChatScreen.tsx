import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated, StyleSheet, type ViewToken,
} from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { conversationId } from '../domain/conversation';
import { useSession, useModelEntries, saveEntry, markSeen, type ScreenEntry } from '../state/store';
import { useAppActive } from '../hooks/useAppActive';
import { logError } from '../utils/log';
import { type ModelData } from '../models/schema';
import { toast } from '../components/Toast';
import { SendIcon } from '../components/icons';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { s, colors } from '../styles';

// ─── Typing Bubble ──────────────────────────────────────

function TypingBubble() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      );
    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [dot1, dot2, dot3]);

  return (
    <View style={cs.typingBubble}>
      {[dot1, dot2, dot3].map((opacity, i) => (
        <Animated.View key={i} style={[cs.typingDot, { opacity }]} />
      ))}
    </View>
  );
}

// ─── Timeline item types ────────────────────────────────

type TimelineItem =
  | (ScreenEntry<ModelData<'directMessage'>> & { _kind: 'message' })
  | (ScreenEntry<ModelData<'pix'>> & { _kind: 'pix' });

const VIEWABILITY = { itemVisiblePercentThreshold: 50 };

// ─── Chat Screen ────────────────────────────────────────

export function ChatScreen({ route }: RootStackScreenProps<'Chat'>) {
  const { friend } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId } = useSession();
  const headerHeight = useHeaderHeight();
  const allMessages = useModelEntries('directMessage');
  const allPix = useModelEntries('pix');
  const [text, setText] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const convId = conversationId(myUserId, friend.userId);

  // Per-conversation slice of the global cache.
  const messages = useMemo(
    () => allMessages.filter(m => m.data.conversationId === convId),
    [allMessages, convId],
  );
  // Pix between me and this friend (sent or received). The conversation id is the membership test:
  // `drain.ts` will only store a pix whose conversation names this user AND its authenticated
  // sender, so a row that reaches this filter is genuinely between the two of us. The old test
  // paired `senderUsername` with `recipientUsername`, two names the sender chose.
  const pixEntries = useMemo(
    () => allPix.filter(p => p.data.conversationId === convId),
    [allPix, convId],
  );

  const onViewPix = (entry: ScreenEntry<ModelData<'pix'>>) => openPixViewer(nav, friend, [entry]);

  // A received message is seen once it is on screen in the focused chat with the app foregrounded.
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    setVisibleIds(new Set(viewableItems.map((v) => (v.item as TimelineItem).id)));
  }).current;
  const markedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!isFocused || !appActive) return;
    for (const m of messages) {
      if (!visibleIds.has(m.id) || m.viewedAt !== null || markedRef.current.has(m.id)) continue;
      if (m.authorUserId === myUserId) continue;
      markedRef.current.add(m.id);
      markSeen('directMessage', m).catch((e) => logError('seen.message:' + m.id, e));
    }
  }, [isFocused, appActive, visibleIds, messages, myUserId]);

  // Typing observer + bubble — separate from entry-cache subscriptions since
  // typing isn't backed by entries.
  useEffect(() => {
    const unsub = onObscuraEvent((event) => {
      if (event.type === 'messageReceived' && event.model === 'directMessage') {
        setPeerTyping(false); // clear typing bubble when a real message arrives
      } else if (event.type === 'typingChanged' && event.conversationId === convId) {
        // Anyone can signal under this context id; only this conversation's friend counts.
        setPeerTyping(event.userIds.includes(friend.userId));
      }
    });
    Obscura.observeTyping(convId);
    return () => {
      unsub();
      Obscura.stopObservingTyping(convId);
    };
  }, [convId, friend.userId]);

  // Build unified timeline sorted by timestamp.
  const timeline: TimelineItem[] = useMemo(() => [
    ...messages.map(m => ({ ...m, _kind: 'message' as const })),
    ...pixEntries.map(p => ({ ...p, _kind: 'pix' as const })),
  ].sort((a, b) => a.sentAt - b.sentAt), [messages, pixEntries]);

  const send = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText('');
    try {
      await Obscura.stopTyping([friend.userId], convId);
      // No `senderUsername`: `saveEntry` stamps the authenticated author, and every reader resolves
      // the name from the friend graph rather than believing what the payload says.
      await saveEntry('directMessage', { conversationId: convId, content: msg });
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const onChangeText = (t: string) => {
    setText(t);
    if (t.length > 0) Obscura.sendTyping([friend.userId], convId);
  };

  const renderItem = ({ item }: { item: TimelineItem }) => {
    // ─── Chat message
    if (item._kind === 'message') {
      const isMine = item.authorUserId === myUserId;
      return (
        <View style={[cs.msgRow, isMine ? cs.msgRowRight : cs.msgRowLeft]}>
          <View style={[cs.msgBubble, isMine ? cs.myBubble : cs.theirBubble]}>
            <Text style={isMine ? cs.myBubbleText : cs.theirBubbleText}>{item.data.content}</Text>
          </View>
        </View>
      );
    }

    // ─── Pix entry
    const iSent = item.authorUserId === myUserId;
    const viewed = !!item.viewedAt;

    if (!iSent && !viewed) {
      // Received, unviewed — yellow "Tap to view" bar
      return (
        <TouchableOpacity style={cs.pixBarFilled} onPress={() => onViewPix(item)}>
          <Text style={cs.pixBarFilledText}>
            {item.data.caption ? `Tap to view: ${item.data.caption}` : 'Tap to view'}
          </Text>
        </TouchableOpacity>
      );
    }

    if (!iSent && viewed) {
      // Received, viewed — dashed outline bar
      return (
        <View style={cs.pixBarViewed}>
          <Text style={cs.pixBarViewedText}>
            {item.data.caption || 'Viewed'}
          </Text>
        </View>
      );
    }

    if (iSent && !viewed) {
      // Sent, not opened — centered gray text
      return (
        <View style={cs.pixStatus}>
          <Text style={cs.pixStatusText}>You sent a pix</Text>
        </View>
      );
    }

    // Sent, they opened — centered gray text
    return (
      <View style={cs.pixStatus}>
        <Text style={cs.pixStatusText}>{friend.username} viewed your pix</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={s.container}>
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        <FlatList
          data={timeline}
          keyExtractor={(item, i) => item.id || `${i}`}
          style={cs.messageList}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={renderItem}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY}
          ListFooterComponent={peerTyping ? (
            <View style={[cs.msgRow, cs.msgRowLeft]}>
              <TypingBubble />
            </View>
          ) : null}
        />

        <View style={cs.composer}>
          <TextInput style={cs.composerInput} placeholder="Message" placeholderTextColor={colors.textDim}
            value={text} onChangeText={onChangeText} />
          <TouchableOpacity style={cs.sendBtn} onPress={send} disabled={!text.trim()}>
            <SendIcon size={20} color={colors.onAccent} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const cs = StyleSheet.create({
  messageList: { flex: 1, paddingHorizontal: 12 },
  msgRow: { marginVertical: 2 },
  msgRowRight: { alignItems: 'flex-end' },
  msgRowLeft: { alignItems: 'flex-start' },
  msgBubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxWidth: '75%' },
  myBubble: { backgroundColor: colors.accent },
  theirBubble: { backgroundColor: colors.surface },
  myBubbleText: { color: colors.onAccent, fontSize: 16 },
  theirBubbleText: { color: colors.text, fontSize: 16 },
  typingBubble: {
    flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 18,
    paddingHorizontal: 14, paddingVertical: 10, gap: 4, marginVertical: 2,
  },
  typingDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim,
  },
  composer: { flexDirection: 'row', padding: 12, gap: 8, borderTopWidth: 0.5, borderTopColor: colors.border },
  composerInput: { flex: 1, backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, color: colors.text, fontSize: 16 },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  pixBarFilled: {
    backgroundColor: colors.accent, borderRadius: 12, padding: 14,
    marginVertical: 4, marginHorizontal: 12, alignItems: 'center',
  },
  pixBarFilledText: { color: '#000', fontWeight: '700', fontSize: 15 },
  pixBarViewed: {
    borderWidth: 2, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: 12,
    padding: 14, marginVertical: 4, marginHorizontal: 12, alignItems: 'center',
  },
  pixBarViewedText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
  pixStatus: { paddingVertical: 12, alignItems: 'center' },
  pixStatusText: { color: colors.textDim, fontSize: 13 },
});
