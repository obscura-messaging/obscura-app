import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, Pressable, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Obscura, type Friend } from '../native/ObscuraModule';
import { conversationId } from '../domain/conversation';
import { useSession, useModelEntries, refreshFriendGraph, type ScreenEntry } from '../state/store';
import { StoriesRow } from './StoriesScreen';
import { Avatar } from '../components/Avatar';
import { toast } from '../components/Toast';
import { MAIN_HEADER_CONTENT_HEIGHT, MainHeaderOverlay } from '../components/MainHeaderOverlay';
import type { RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { timeAgo } from '../utils/format';
import { colors } from '../styles';

type PixState = 'received_new' | 'received_viewed' | 'sent_pending' | 'sent_opened' | 'none';

interface FriendActivity {
  friend: Friend;
  lastMessage?: ScreenEntry;
  unopenedPix: ScreenEntry[];
  pixState: PixState;
  pixCount: number;
  latestTimestamp: number;
}

export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { friends, pending, myUserId } = useSession();
  const messages = useModelEntries('directMessage');
  const pixEntries = useModelEntries('pix');
  const [acceptingUserId, setAcceptingUserId] = useState<string | null>(null);

  const onViewPix = (sender: Friend, entries: ScreenEntry[]) => openPixViewer(nav, sender, entries);
  const onAcceptFriend = useCallback(async (friend: Friend) => {
    if (acceptingUserId !== null) return;
    setAcceptingUserId(friend.userId);
    try {
      await Obscura.acceptFriend(friend.userId);
      await refreshFriendGraph();
      toast.success(`You and ${friend.username} are now friends`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not accept friend request');
    } finally {
      setAcceptingUserId(null);
    }
  }, [acceptingUserId]);

  // Build activity list — each friend with their latest chat + pix state.
  // Memoized so the four filter passes per friend don't run on every render.
  //
  // Membership is the CONVERSATION id and direction is the AUTHENTICATED author — never
  // `senderUsername` / `recipientUsername`, which are names the sender chose. The conversation id is
  // checked on the way in (`drain.ts`) to name this user and the actual sender, so a stranger cannot
  // put an entry into a conversation with a friend, and `authorUserId` is the envelope's sender, never
  // the payload's. `includes(f.userId)` was also a substring test on an id, which a
  // prefix-sharing id would have satisfied.
  const activities: FriendActivity[] = useMemo(() => friends.map(f => {
    const convId = conversationId(myUserId, f.userId);
    const isMine = (e: ScreenEntry) => e.authorUserId === myUserId;
    const inConversation = (e: ScreenEntry) => e.data.conversationId === convId;

    const friendMessages = messages.filter(inConversation);
    const lastMessage = friendMessages.sort((a, b) => b.sentAt - a.sentAt)[0];

    const conversationPix = pixEntries.filter(inConversation);
    const receivedNew = conversationPix.filter(p => !isMine(p) && !p.viewedAt);
    const receivedViewed = conversationPix.filter(p => !isMine(p) && !!p.viewedAt);
    const sentPending = conversationPix.filter(p => isMine(p) && !p.viewedAt);
    const sentOpened = conversationPix.filter(p => isMine(p) && !!p.viewedAt);

    const allPix = [...receivedNew, ...receivedViewed, ...sentPending, ...sentOpened]
      .sort((a, b) => b.sentAt - a.sentAt);
    const latest = allPix[0];
    let pixState: PixState = 'none';
    if (latest) {
      if (receivedNew.includes(latest)) pixState = 'received_new';
      else if (receivedViewed.includes(latest)) pixState = 'received_viewed';
      else if (sentPending.includes(latest)) pixState = 'sent_pending';
      else if (sentOpened.includes(latest)) pixState = 'sent_opened';
    }

    const latestTimestamp = Math.max(
      lastMessage?.sentAt || 0,
      ...allPix.map(p => p.sentAt), 0
    );
    return { friend: f, lastMessage, unopenedPix: receivedNew, pixState, pixCount: receivedNew.length, latestTimestamp };
  }).sort((a, b) => b.latestTimestamp - a.latestTimestamp), [friends, messages, pixEntries, myUserId]);

  return (
    // Full-screen page under the floating transparent header (pad content clear
    // of it). Horizontal swipe is owned by the tab pager, not this screen.
    <View style={[cl.page, { paddingTop: insets.top + MAIN_HEADER_CONTENT_HEIGHT + 8 }]}>
      <MainHeaderOverlay camera={false} />
      {/* Stories row */}
      <StoriesRow />

      {/* Pending requests */}
      {pending.length > 0 && pending.map(f => {
        const content = (
          <>
            <Avatar name={f.username} size={44} background={colors.surfaceMuted} color={colors.text} />
            <View style={cl.info}>
              <Text style={cl.username}>{f.username}</Text>
              <Text style={cl.preview}>
                {f.status === 'pending_received' ? 'Wants to be friends' : 'Request sent'}
              </Text>
            </View>
            {f.status === 'pending_received' && (
              <View style={cl.acceptBtn}>
                <Text style={cl.acceptBtnText}>
                  {acceptingUserId === f.userId ? 'Accepting…' : 'Accept'}
                </Text>
              </View>
            )}
          </>
        );

        return f.status === 'pending_received' ? (
          <Pressable
            key={f.userId}
            style={cl.row}
            onPress={() => onAcceptFriend(f)}
            disabled={acceptingUserId !== null}
            accessibilityRole="button"
            accessibilityLabel={`Accept friend request from ${f.username}`}
            hitSlop={8}
          >
            {content}
          </Pressable>
        ) : (
          <View key={f.userId} style={cl.row}>{content}</View>
        );
      })}

      {/* Unified friend list */}
      <FlatList
        data={activities}
        keyExtractor={item => item.friend.userId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => {
          const hasPix = item.unopenedPix.length > 0;
          const mine = item.lastMessage !== undefined
            && item.lastMessage.authorUserId === myUserId;
          const preview = item.lastMessage?.data.content
            ? `${mine ? 'You: ' : ''}${item.lastMessage.data.content}`
            : 'Tap to chat';

          return (
            <View style={cl.row}>
              {/* Left: pix icon — tap opens pix viewer */}
              <TouchableOpacity
                style={cl.iconZone}
                onPress={() => hasPix ? onViewPix(item.friend, item.unopenedPix) : nav.navigate('Chat', { friend: item.friend })}
              >
                {item.pixState === 'received_new' ? (
                  <View style={cl.iconCircleFilled}>
                    {item.pixCount > 1 && <Text style={cl.iconCount}>{item.pixCount}</Text>}
                  </View>
                ) : item.pixState === 'received_viewed' ? (
                  <View style={cl.iconCircleOutline}>
                    <View style={cl.iconCircleOutlineInner} />
                  </View>
                ) : item.pixState === 'sent_pending' ? (
                  <View style={cl.iconArrowFilled} />
                ) : item.pixState === 'sent_opened' ? (
                  <View style={cl.iconArrowOutline} />
                ) : (
                  <Avatar name={item.friend.username} size={44} />
                )}
              </TouchableOpacity>

              {/* Right: name + preview — tap opens chat */}
              <TouchableOpacity style={cl.chatZone} onPress={() => nav.navigate('Chat', { friend: item.friend })}>
                <View style={cl.info}>
                  <Text style={cl.username}>{item.friend.username}</Text>
                  <Text style={cl.preview} numberOfLines={1}>{preview}</Text>
                </View>
                {item.latestTimestamp > 0 && (
                  <Text style={cl.time}>{timeAgo(item.latestTimestamp)}</Text>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={
          friends.length === 0
            ? <Text style={cl.empty}>No friends yet — share your code</Text>
            : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 56 }}
      />
    </View>
  );
}

const cl = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  addInput: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14 },
  addBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  addBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  iconZone: { width: 64, alignItems: 'center', justifyContent: 'center', paddingLeft: 8 },
  chatZone: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  // Pix state icons
  iconCircleFilled: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  iconCircleOutline: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  iconCircleOutlineInner: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: colors.bg,
  },
  iconArrowFilled: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  iconArrowOutline: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent', opacity: 0.4 },
  iconCount: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  info: { flex: 1 },
  username: { color: '#fff', fontSize: 16, fontWeight: '600' },
  preview: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  time: { color: colors.textDim, fontSize: 12 },
  acceptBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  acceptBtnText: { color: '#000', fontWeight: '700', fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  copyBtn: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 12, alignItems: 'center' },
  copyBtnText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
});
