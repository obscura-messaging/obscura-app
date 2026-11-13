import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Pressable, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activityPreview, friendActivities, type PixBadge } from '../domain/chats';
import { pendingFriendSubtitle, removeFriendPrompt } from '../domain/friends';
import {
  useSession,
  useMessages,
  useAcceptedFriends,
  usePendingFriends,
  acceptFriend,
  removeFriend,
  type Friend,
} from '../state/store';
import { StoriesRow } from '../components/StoriesRow';
import { Avatar } from '../components/Avatar';
import { confirm } from '../components/confirm';
import { toast } from '../components/Toast';
import { MAIN_HEADER_CONTENT_HEIGHT, MainHeaderOverlay } from '../components/MainHeaderOverlay';
import type { RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { timeAgo } from '../utils/format';
import { errorMessage } from '../utils/log';
import { colors } from '../styles';

function PixAvatar({ badge, friend }: { badge: PixBadge; friend: Friend }) {
  const hasNew = badge?.kind === 'new';
  return (
    <View style={cl.avatarWrap}>
      <Avatar
        name={friend.username}
        size={48}
        background={hasNew ? colors.accent : colors.surface}
        color={hasNew ? colors.onAccent : colors.text}
      />
      {badge !== null && (
        <View
          style={[
            cl.statusBadge,
            badge.kind === 'new' && cl.badgeNew,
            badge.kind === 'sent' && cl.badgeSent,
            badge.kind === 'opened' && cl.badgeOpened,
          ]}
        >
          {badge.kind === 'new' && badge.count > 1 && (
            <Text style={cl.badgeCount}>{badge.count}</Text>
          )}
        </View>
      )}
    </View>
  );
}

interface PendingRowProps {
  friend: Friend;
  accepting: boolean;
  /** Only the primary accepts; null until the session loads. */
  isPrimary: boolean | null;
  onAccept?: () => void;
  onLongPress?: () => void;
}

function PendingRow({ friend, accepting, isPrimary, onAccept, onLongPress }: PendingRowProps) {
  const received = friend.status === 'pending_received';
  const actionable = received && isPrimary === true;
  const content = (
    <>
      <Avatar
        name={friend.username}
        size={48}
        background={colors.surfaceMuted}
        color={colors.text}
      />
      <View style={cl.info}>
        <Text style={cl.username}>{friend.username}</Text>
        <Text style={cl.preview}>{pendingFriendSubtitle(friend, isPrimary)}</Text>
      </View>
      {actionable && (
        <View style={cl.acceptBtn}>
          <Text style={cl.acceptBtnText}>{accepting ? 'Accepting…' : 'Accept'}</Text>
        </View>
      )}
    </>
  );
  if (!actionable && !onLongPress) return <View style={cl.pendingRow}>{content}</View>;
  return (
    <Pressable
      style={cl.pendingRow}
      onPress={actionable ? onAccept : undefined}
      onLongPress={onLongPress}
      disabled={!actionable && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={
        actionable ? `Accept friend request from ${friend.username}` : friend.username
      }
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
  const items = useMessages();
  const [acceptingUserId, setAcceptingUserId] = useState<string | null>(null);

  const activities = useMemo(
    () => friendActivities(friends, myUserId, items),
    [friends, myUserId, items],
  );

  const accept = async (friend: Friend) => {
    setAcceptingUserId(friend.userId);
    try {
      await acceptFriend(friend.userId);
      toast.success(`You and ${friend.username} are now friends`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAcceptingUserId(null);
    }
  };

  const openChat = (friend: Friend) =>
    nav.navigate('Chat', { userId: friend.userId, username: friend.username });

  const confirmRemoveFriend = async (friend: Friend) => {
    if (isPrimary !== true) return;
    const { title, body, actionLabel } = removeFriendPrompt(friend);
    const confirmed = await confirm(title, body, actionLabel, true);
    if (!confirmed) return;
    try {
      await removeFriend(friend.userId);
      toast.success(`Removed ${friend.username}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    // Padded clear of the floating header; horizontal swipes belong to the tab pager.
    <View style={[cl.page, { paddingTop: insets.top + MAIN_HEADER_CONTENT_HEIGHT + 8 }]}>
      <MainHeaderOverlay camera={false} />

      <FlatList
        data={activities}
        keyExtractor={item => item.friend.userId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <>
            <StoriesRow />
            <View style={cl.divider} />
            {pending.map(f => (
              <PendingRow
                key={f.userId}
                friend={f}
                accepting={acceptingUserId === f.userId}
                isPrimary={isPrimary}
                onAccept={acceptingUserId === null ? () => accept(f) : undefined}
                onLongPress={isPrimary === true ? () => confirmRemoveFriend(f) : undefined}
              />
            ))}
          </>
        }
        renderItem={({ item }) => {
          const { text: preview, highlight } = activityPreview(item, myUserId);
          return (
            <TouchableOpacity
              style={cl.row}
              onPress={() =>
                item.unopenedPix.length > 0
                  ? openPixViewer(nav, item.friend, item.unopenedPix)
                  : openChat(item.friend)
              }
              onLongPress={isPrimary === true ? () => confirmRemoveFriend(item.friend) : undefined}
            >
              <PixAvatar badge={item.badge} friend={item.friend} />
              <View style={cl.chatZone}>
                <View style={cl.info}>
                  <Text style={cl.username}>{item.friend.username}</Text>
                  <Text style={[cl.preview, highlight && cl.previewHighlight]} numberOfLines={1}>
                    {preview}
                  </Text>
                </View>
                {item.latestAt > 0 && <Text style={cl.time}>{timeAgo(item.latestAt)}</Text>}
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          pending.length === 0 ? (
            <View style={cl.emptyWrap}>
              <Text style={cl.emptyTitle}>No friends yet</Text>
              <Text style={cl.emptySub}>Share your QR or friend code to start messaging.</Text>
              <TouchableOpacity style={cl.emptyBtn} onPress={() => nav.navigate('AddFriend')}>
                <Text style={cl.emptyBtnText}>Add a friend</Text>
              </TouchableOpacity>
            </View>
          ) : undefined
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 72 }}
      />
    </View>
  );
}

const cl = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    gap: 12,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 12,
  },
  chatZone: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 8 },
  avatarWrap: { width: 48, height: 48 },
  statusBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    borderWidth: 2,
    borderColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeNew: { backgroundColor: colors.accent, borderColor: colors.bg },
  badgeSent: { backgroundColor: colors.accent },
  badgeOpened: { backgroundColor: colors.surfaceMuted },
  badgeCount: { color: colors.onAccent, fontWeight: '800', fontSize: 10 },
  info: { flex: 1 },
  username: { color: colors.text, fontSize: 16, fontWeight: '600' },
  preview: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  previewHighlight: { color: colors.accent, fontWeight: '700' },
  time: { color: colors.textDim, fontSize: 12 },
  acceptBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  acceptBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 13 },
  emptyWrap: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 6 },
  emptySub: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginBottom: 20 },
  emptyBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  emptyBtnText: { color: colors.accent, fontWeight: '700', fontSize: 14 },
});
