import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { pendingFriendSubtitle, removeFriendPrompt, type Friend } from '../../domain/friends';
import { acceptFriend, addFriend, removeFriend, useAcceptedFriends, usePendingFriends, useSession } from '../../state/store';
import { toast } from '../../state/toast';
import { errorMessage } from '../../utils/log';
import type { RootStackParamList } from '../../navigation/types';
import { DARK_OVERLAY, withAlpha } from '../theme';
import { useUi2Theme } from '../store';
import { confirm } from '../confirm';
import { Avatar } from '../components/Avatar';
import { Hint, Page, PillButton, PillInput, SectionLabel } from '../components/Page';

// claude: requests, adding a friend and the friend list. The accept, decline and remove rules are the old chat list's.
export function FriendsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const { isPrimary } = useSession();
  const friends = useAcceptedFriends();
  const pending = usePendingFriends();
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [acceptingUserId, setAcceptingUserId] = useState<string | null>(null);

  const add = async () => {
    if (!code.trim() || adding) return;
    setAdding(true);
    try {
      await addFriend(code);
      setCode('');
      toast.success('Friend request sent');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

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

  const remove = async (friend: Friend) => {
    if (isPrimary !== true) return;
    const { title, body, actionLabel } = removeFriendPrompt(friend);
    if (!(await confirm(title, body, actionLabel, true))) return;
    try {
      await removeFriend(friend.userId);
      toast.success(`Removed ${friend.username}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const dark = theme.mode === 'dark';
  const avatarLine = dark ? withAlpha(DARK_OVERLAY.avatarOutline.color, DARK_OVERLAY.avatarOutline.alpha) : theme.outline;
  const person = (friend: Friend, subtitle: string | null) => (
    <>
      <Avatar name={friend.username} size={44} radius={14} outline={avatarLine} ink={theme.onSecondary.ink} />
      <View style={styles.main}>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>{friend.username}</Text>
        {subtitle !== null && <Text style={[styles.sub, { color: theme.muted }]} numberOfLines={1}>{subtitle}</Text>}
      </View>
    </>
  );

  return (
    <Page title="Friends">
      {pending.length > 0 && <SectionLabel>Requests</SectionLabel>}
      {pending.map(friend => {
        const canAccept = friend.status === 'pending_received' && isPrimary === true;
        const accepting = acceptingUserId === friend.userId;
        return (
          <TouchableOpacity
            key={friend.userId}
            style={styles.row}
            activeOpacity={1}
            onLongPress={() => remove(friend)}
            accessibilityLabel={friend.username}
          >
            {person(friend, pendingFriendSubtitle(friend, isPrimary))}
            {canAccept && (
              <PillButton label={accepting ? 'Accepting…' : 'Accept'} onPress={() => accept(friend)} disabled={acceptingUserId !== null} />
            )}
          </TouchableOpacity>
        );
      })}

      {isPrimary === true && (
        <>
          <SectionLabel>Add a friend</SectionLabel>
          <View style={styles.enter}>
            <PillInput placeholder="Paste friend code" value={code} onChangeText={setCode} />
            <PillButton label={adding ? '…' : 'Add'} onPress={add} disabled={adding} />
          </View>
          <PillButton label="Scan a friend's QR" tone="plain" onPress={() => nav.navigate('ScanFriend')} />
        </>
      )}
      {isPrimary === false && <Hint>Friends are added and accepted on your primary device.</Hint>}

      {friends.length > 0 && <SectionLabel>Your friends</SectionLabel>}
      {friends.map(friend => (
        <TouchableOpacity
          key={friend.userId}
          style={styles.row}
          onPress={() => nav.navigate('Chat', { userId: friend.userId, username: friend.username })}
          onLongPress={() => remove(friend)}
        >
          {person(friend, null)}
        </TouchableOpacity>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  main: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 15, fontWeight: '900' },
  sub: { fontSize: 13, fontWeight: '600' },
  enter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
