import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { errorMessage, logError } from '../utils/log';
import { encodeFriendQR } from '../domain/friendQR';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

export function AddFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [myCode, setMyCode] = useState('');
  const [codeInput, setCodeInput] = useState('');

  useEffect(() => {
    Obscura.getFriendCode().then(setMyCode).catch((e) => logError('getFriendCode', e));
  }, []);

  const copyMyCode = async () => {
    if (!myCode) return;
    try { await Obscura.setClipboard(myCode); toast.success('Friend code copied'); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  const addByCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try { await Obscura.addFriendByCode(code); setCodeInput(''); toast.success('Friend request sent'); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <View style={afs.container}>
      <View style={afs.qrCard}>
        {myCode
          ? <QRCode value={encodeFriendQR(myCode)} size={216} backgroundColor="transparent" color={colors.text} />
          : <Text style={afs.dim}>Loading…</Text>}
      </View>
      <Text style={afs.caption}>Friends can scan this to add you</Text>

      {!!myCode && (
        <TouchableOpacity style={afs.codePill} onPress={copyMyCode}>
          <Text style={afs.codeText} numberOfLines={1}>{myCode}</Text>
          <Text style={afs.copyHint}>Copy</Text>
        </TouchableOpacity>
      )}

      <View style={afs.divider} />

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
    </View>
  );
}

const afs = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, alignItems: 'center' },
  qrCard: {
    width: 256, height: 256, borderRadius: 20, backgroundColor: colors.surface,
    justifyContent: 'center', alignItems: 'center', marginTop: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  dim: { color: colors.textDim, fontSize: 14 },
  caption: { color: colors.textDim, fontSize: 13, marginTop: 12 },
  codePill: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16,
    backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.border, maxWidth: '100%',
  },
  codeText: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  copyHint: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  divider: { height: 1, backgroundColor: colors.border, alignSelf: 'stretch', marginVertical: 24 },
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
