import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { CodeCard } from '../components/CodeCard';
import { useSession } from '../state/store';
import { primaryOnly } from '../state/devices';
import { errorMessage, logError } from '../utils/log';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

export function AddFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { isPrimary } = useSession();
  const [myCode, setMyCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');

  useEffect(() => {
    Obscura.getFriendCode().then(setMyCode).catch((e) => logError('getFriendCode', e));
  }, []);

  const addByCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try {
      await primaryOnly(() => Obscura.addFriendByCode(code));
      setCodeInput('');
      toast.success('Friend request sent');
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <View style={afs.container}>
      <CodeCard kind="friend" code={myCode} caption="Friends can scan this to add you" copiedMessage="Friend code copied" />

      <View style={afs.divider} />

      {isPrimary === false && (
        <Text style={afs.note}>Friends are added and accepted on your primary device.</Text>
      )}
      {isPrimary === true && (<>
        <Text style={afs.sectionLabel}>add by code</Text>
        <View style={afs.enterRow}>
          <TextInput
            style={afs.input}
            placeholder="Paste friend code"
            placeholderTextColor={colors.textDim}
            value={codeInput}
            onChangeText={setCodeInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={afs.addBtn} onPress={addByCode}>
            <Text style={afs.addBtnText}>Add</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={afs.scanBtn} onPress={() => nav.navigate('ScanFriend')}>
          <Text style={afs.scanBtnText}>Scan a friend's QR</Text>
        </TouchableOpacity>
      </>)}
    </View>
  );
}

const afs = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, alignItems: 'center' },
  divider: { height: 1, backgroundColor: colors.border, alignSelf: 'stretch', marginVertical: 24 },
  note: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  sectionLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', alignSelf: 'flex-start', marginBottom: 8 },
  enterRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: colors.text, fontSize: 15, borderWidth: 1, borderColor: colors.border,
  },
  addBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center' },
  addBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 15 },
  scanBtn: {
    alignSelf: 'stretch', marginTop: 20, backgroundColor: colors.surface, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  scanBtnText: { color: colors.text, fontWeight: '700', fontSize: 15 },
});
