import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { toast } from '../components/Toast';
import { CodeCard } from '../components/CodeCard';
import { useSession, addFriend, getFriendCode } from '../state/store';
import { errorMessage } from '../domain/errors';
import { logError } from '../utils/log';
import type { RootStackParamList } from '../navigation/types';
import { s, colors } from '../styles';

export function AddFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const { isPrimary } = useSession();
  const [myCode, setMyCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    getFriendCode().then(setMyCode).catch((e) => logError('getFriendCode', e));
  }, []);

  const addByCode = async () => {
    if (!codeInput.trim() || adding) return;
    setAdding(true);
    try {
      await addFriend(codeInput);
      setCodeInput('');
      toast.success('Friend request sent');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <View style={[afs.container, { paddingBottom: insets.bottom + 24 }]}>
      <CodeCard kind="friend" code={myCode} caption="Friends can scan this to add you" copiedMessage="Friend code copied" />

      <View style={afs.divider} />

      {isPrimary === false && (
        <Text style={afs.note}>Friends are added and accepted on your primary device.</Text>
      )}
      {isPrimary === true && (<>
        <Text style={[s.sectionTitle, afs.sectionLabel]}>add by code</Text>
        <View style={afs.enterRow}>
          <TextInput
            style={[s.input, afs.input]}
            placeholder="Paste friend code"
            placeholderTextColor={colors.textDim}
            value={codeInput}
            onChangeText={setCodeInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={[s.primaryBtn, adding && s.btnDisabled]} onPress={addByCode} disabled={adding}>
            <Text style={s.primaryBtnText}>{adding ? '…' : 'Add'}</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={[s.secondaryBtn, afs.scanBtn]} onPress={() => nav.navigate('ScanFriend')}>
          <Text style={s.secondaryBtnText}>Scan a friend's QR</Text>
        </TouchableOpacity>
      </>)}
    </View>
  );
}

const afs = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, alignItems: 'center' },
  divider: { height: 1, backgroundColor: colors.border, alignSelf: 'stretch', marginVertical: 24 },
  note: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
  sectionLabel: { alignSelf: 'flex-start', marginTop: 0 },
  enterRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  input: { flex: 1, marginBottom: 0 },
  scanBtn: { alignSelf: 'stretch', marginTop: 16 },
});
