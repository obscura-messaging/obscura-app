import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Pressable, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Obscura, type Friend } from '../native/ObscuraModule';
import { friendActivities } from '../domain/chats';
import type { PixStatus } from '../domain/pix';
import {
  useSession, useModelEntries, useAcceptedFriends, usePendingFriends, refreshFriends,
} from '../state/store';
import { primaryOnly } from '../state/devices';
import { StoriesRow } from './StoriesScreen';
import { Avatar } from '../components/Avatar';
import { toast } from '../components/Toast';
import { MAIN_HEADER_CONTENT_HEIGHT, MainHeaderOverlay } from '../components/MainHeaderOverlay';
import type { RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { timeAgo } from '../utils/format';
import { errorMessage } from '../utils/log';
import { colors } from '../styles';

function PixIcon({ status, unopened, friend }: { status: PixStatus | undefined; unopened: number; friend: Friend }) {
  switch (status) {
    case 'received_new':
      return <View style={cl.circle}>{unopened > 1 && <Text style={cl.count}>{unopened}</Text>}</View>;
    case 'received_viewed':
      return <View style={cl.circle}><View style={cl.circleHole} /></View>;
    case 'sent_pending':
      return <View style={cl.arrow} />;
    case 'sent_opened':
      return <View style={[cl.arrow, cl.faded]} />;
    case undefined:
      return <Avatar name={friend.username} size={44} />;
  }
}

interface PendingRowProps {
  friend: Friend;
  accepting: boolean;
  /** Only the primary accepts; null until the session loads. */
  isPrimary: boolean | null;
  onAccept?: () => void;
}

function PendingRow({ friend, accepting, isPrimary, onAccept }: PendingRowProps) {
  const received = friend.status === 'pending_received';
  const actionable = received && isPrimary === true;
  const content = (
    <>
      <Avatar name={friend.username} size={44} background={colors.surfaceMuted} color={colors.text} />
      <View style={cl.info}>
        <Text style={cl.username}>{friend.username}</Text>
        <Text style={cl.preview}>
          {!received ? 'Request sent' : isPrimary === false ? 'Wants to be friends · accept on your primary' : 'Wants to be friends'}
        </Text>
      </View>
      {actionable && (
        <View style={cl.acceptBtn}>
          <Text style={cl.acceptBtnText}>{accepting ? 'Accepting…' : 'Accept'}</Text>
        </View>
      )}
    </>
  );
  if (!actionable) return <View style={cl.row}>{content}</View>;
  return (
    <Pressable
      style={cl.row}
      onPress={onAccept}
      disabled={onAccept === undefined}
      accessibilityRole="button"
      accessibilityLabel={`Accept friend request from ${friend.username}`}
      hitSlop={8}
    >
      {content}
    </Pressable>
  );
}

export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { myUserId, isPrimary } = useSession();
  const friends = useAcceptedFriends();
  const pending = usePendingFriends();
  const messages = useModelEntries('directMessage');
  const pix = useModelEntries('pix');
  const [acceptingUserId, setAcceptingUserId] = useState<string | null>(null);

  const activities = useMemo(
    () => friendActivities(friends, myUserId, messages, pix),
    [friends, myUserId, messages, pix],
  );

  const accept = async (friend: Friend) => {
    setAcceptingUserId(friend.userId);
    try {
      await primaryOnly(() => Obscura.acceptFriend(friend.userId));
      await refreshFriends();
      toast.success(`You and ${friend.username} are now friends`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAcceptingUserId(null);
    }
  };

  const openChat = (friend: Friend) => nav.navigate('Chat', { friend });

  return (
    // Padded clear of the floating header; horizontal swipes belong to the tab pager.
    <View style={[cl.page, { paddingTop: insets.top + MAIN_HEADER_CONTENT_HEIGHT + 8 }]}>
      <MainHeaderOverlay camera={false} />
      <StoriesRow />

      {pending.map((f) => (
        <PendingRow
          key={f.userId}
          friend={f}
          accepting={acceptingUserId === f.userId}
          isPrimary={isPrimary}
          onAccept={acceptingUserId === null ? () => accept(f) : undefined}
        />
      ))}

      <FlatList
        data={activities}
        keyExtractor={(item) => item.friend.userId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => {
          const content = item.lastMessage?.data.content;
          const preview = content
            ? `${item.lastMessage?.authorUserId === myUserId ? 'You: ' : ''}${content}`
            : 'Tap to chat';
          return (
            <View style={cl.row}>
              <TouchableOpacity
                style={cl.iconZone}
                onPress={() => (item.unopenedPix.length > 0
                  ? openPixViewer(nav, item.friend, item.unopenedPix)
                  : openChat(item.friend))}
              >
                <PixIcon status={item.latestPix} unopened={item.unopenedPix.length} friend={item.friend} />
              </TouchableOpacity>
              <TouchableOpacity style={cl.chatZone} onPress={() => openChat(item.friend)}>
                <View style={cl.info}>
                  <Text style={cl.username}>{item.friend.username}</Text>
                  <Text style={cl.preview} numberOfLines={1}>{preview}</Text>
                </View>
                {item.latestAt > 0 && <Text style={cl.time}>{timeAgo(item.latestAt)}</Text>}
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={cl.empty}>No friends yet — share your code</Text>}
        contentContainerStyle={{ paddingBottom: insets.bottom + 56 }}
      />
    </View>
  );
}

const cl = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  iconZone: { width: 64, alignItems: 'center', justifyContent: 'center', paddingLeft: 8 },
  chatZone: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  circle: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  circleHole: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.bg },
  arrow: {
    width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16,
    borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent',
  },
  faded: { opacity: 0.4 },
  count: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  info: { flex: 1 },
  username: { color: colors.text, fontSize: 16, fontWeight: '600' },
  preview: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  time: { color: colors.textDim, fontSize: 12 },
  acceptBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  acceptBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
});
