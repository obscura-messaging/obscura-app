import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { errorMessage } from '../utils/log';
import { toast } from '../components/Toast';
import { CheckIcon } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useAcceptedFriends } from '../state/store';
import { sendCapture } from '../state/sendMedia';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

export function RecipientPicker({ route }: RootStackScreenProps<'RecipientPicker'>) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const friends = useAcceptedFriends();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeStory, setIncludeStory] = useState(false);
  const [sending, setSending] = useState(false);

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  };

  const send = async () => {
    const recipients = friends.filter((f) => selected.has(f.userId));
    if (recipients.length === 0 && !includeStory) return;
    setSending(true);
    try {
      const undelivered = await sendCapture(route.params, recipients, includeStory);
      // Off the stack, so the sent capture cannot be navigated back into.
      nav.popToTop();
      if (undelivered.length > 0) {
        toast.error(`Not delivered to ${undelivered.join(', ')}`);
      } else {
        toast.success(
          `Sent to ${recipients.length} friend${recipients.length !== 1 ? 's' : ''}${includeStory ? ' + story' : ''}`,
        );
      }
    } catch (e) {
      toast.error(errorMessage(e));
      setSending(false);
    }
  };

  const count = selected.size + (includeStory ? 1 : 0);

  return (
    <SafeAreaView style={rp.container} edges={['top']}>
      <View style={rp.header}>
        <TouchableOpacity onPress={() => nav.goBack()} disabled={sending}>
          <Text style={rp.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={rp.title}>Send to</Text>
        <View style={rp.headerSpacer} />
      </View>

      <TouchableOpacity style={rp.row} onPress={() => setIncludeStory((v) => !v)} disabled={sending}>
        <View style={[rp.check, includeStory && rp.checkActive]}>
          {includeStory && <CheckIcon size={15} color={colors.onAccent} />}
        </View>
        <Text style={rp.rowText}>My story</Text>
        <Text style={rp.rowHint}>Visible to all friends</Text>
      </TouchableOpacity>

      <Text style={rp.sectionTitle}>friends</Text>

      <FlatList
        data={friends}
        keyExtractor={f => f.userId}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.userId);
          return (
            <TouchableOpacity style={rp.row} onPress={() => toggle(item.userId)} disabled={sending}>
              <View style={[rp.check, isSelected && rp.checkActive]}>
                {isSelected && <CheckIcon size={15} color={colors.onAccent} />}
              </View>
              <Avatar name={item.username} size={36} background={colors.surfaceMuted} color={colors.text} />
              <Text style={rp.rowText}>{item.username}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<Text style={rp.empty}>No friends yet</Text>}
      />

      <TouchableOpacity
        style={[rp.sendBtn, (count === 0 || sending) && rp.sendBtnDisabled]}
        onPress={send}
        disabled={count === 0 || sending}
      >
        <Text style={rp.sendBtnText}>
          {sending ? 'Sending…' : count === 0 ? 'Select recipients' : `Send to ${count}`}
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const rp = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  headerSpacer: { width: 50 },
  cancelText: { color: colors.accent, fontSize: 16 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginLeft: 16, marginTop: 16, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.textMuted, justifyContent: 'center', alignItems: 'center' },
  checkActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  rowText: { color: colors.text, fontSize: 16, flex: 1 },
  rowHint: { color: colors.textDim, fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center', margin: 16, marginBottom: 40 },
  sendBtnDisabled: { backgroundColor: colors.surfaceMuted },
  sendBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
});
