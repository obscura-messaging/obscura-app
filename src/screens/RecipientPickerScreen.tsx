import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { errorMessage } from '../domain/errors';
import { sendButtonLabel, sendOutcomeToast } from '../domain/friends';
import { toast } from '../components/Toast';
import { CheckIcon } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useAcceptedFriends } from '../state/store';
import { sendCapture } from '../state/sendMedia';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { s, colors } from '../styles';

export function RecipientPickerScreen({ route }: RootStackScreenProps<'RecipientPicker'>) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const friends = useAcceptedFriends();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeStory, setIncludeStory] = useState(false);
  const [sending, setSending] = useState(false);

  const toggle = (userId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  };

  const send = async () => {
    const recipients = friends.filter(f => selected.has(f.userId));
    if (recipients.length === 0 && !includeStory) return;
    setSending(true);
    try {
      const undelivered = await sendCapture(route.params, recipients, includeStory);
      // Off the stack, so the sent capture cannot be navigated back into.
      nav.popToTop();
      const outcome = sendOutcomeToast(recipients.length, includeStory, undelivered);
      if (outcome.kind === 'error') toast.error(outcome.message);
      else toast.success(outcome.message);
    } catch (e) {
      toast.error(errorMessage(e));
      setSending(false);
    }
  };

  const count = selected.size + (includeStory ? 1 : 0);

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => nav.goBack()} disabled={sending}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Send to</Text>
        <View style={styles.headerSpacer} />
      </View>

      <TouchableOpacity
        style={styles.row}
        onPress={() => setIncludeStory(v => !v)}
        disabled={sending}
      >
        <View style={[styles.check, includeStory && styles.checkActive]}>
          {includeStory && <CheckIcon size={15} color={colors.onAccent} />}
        </View>
        <Text style={styles.rowText}>My story</Text>
        <Text style={styles.rowHint}>Visible to all friends</Text>
      </TouchableOpacity>

      <Text style={[s.sectionTitle, styles.sectionTitle]}>friends</Text>

      <FlatList
        data={friends}
        keyExtractor={f => f.userId}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.userId);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => toggle(item.userId)}
              disabled={sending}
            >
              <View style={[styles.check, isSelected && styles.checkActive]}>
                {isSelected && <CheckIcon size={15} color={colors.onAccent} />}
              </View>
              <Avatar
                name={item.username}
                size={36}
                background={colors.surfaceMuted}
                color={colors.text}
              />
              <Text style={styles.rowText}>{item.username}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No friends yet</Text>}
      />

      <TouchableOpacity
        style={[s.primaryBtn, styles.sendBtn, (count === 0 || sending) && styles.sendBtnDisabled]}
        onPress={send}
        disabled={count === 0 || sending}
      >
        <Text style={s.primaryBtnText}>
          {sendButtonLabel(selected.size, includeStory, sending)}
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerSpacer: { width: 50 },
  cancelText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sectionTitle: { marginLeft: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: colors.textMuted,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  rowText: { color: colors.text, fontSize: 16, flex: 1 },
  rowHint: { color: colors.textDim, fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  sendBtn: { margin: 16 },
  sendBtnDisabled: { backgroundColor: colors.surfaceMuted },
});
