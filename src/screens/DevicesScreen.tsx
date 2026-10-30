import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { DeviceInfo } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { confirm } from '../components/confirm';
import { deviceLabel } from '../domain/devices';
import { approveLink, linkCodeDeviceName, loadDevices, unlinkDevice } from '../state/devices';
import { useSession } from '../state/store';
import { errorMessage } from '../utils/log';
import type { RootStackParamList } from '../navigation/types';
import { s, colors } from '../styles';

/** Show the device named in a link code, and approve it once the user confirms. Resolves whether it linked. */
export async function confirmAndApproveLink(code: string): Promise<boolean> {
  let name: string | null;
  try {
    name = await linkCodeDeviceName(code);
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
  if (name === null) {
    toast.error('That is not a device link code');
    return false;
  }
  const label = deviceLabel({ name });
  const confirmed = await confirm(
    `Link “${label}”?`,
    'It gets your account, friends and message history, and can send and receive as you. Only link a device you own.',
    'Link',
  );
  if (!confirmed) return false;
  try {
    await approveLink(code);
    toast.success(`${label} linked`);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}

export function DevicesScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const focused = useIsFocused();
  const { isPrimary } = useSession();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');

  const refresh = useCallback(() => {
    loadDevices()
      .then((list) => { setDevices(list); setLoadError(null); })
      .catch((e) => setLoadError(errorMessage(e)));
  }, []);

  useEffect(() => { if (focused) refresh(); }, [focused, refresh]);

  const linkPasted = async () => {
    if (await confirmAndApproveLink(codeInput)) {
      setCodeInput('');
      refresh();
    }
  };

  const unlink = async (device: DeviceInfo) => {
    const confirmed = device.isThisDevice
      ? await confirm('Unlink this device?', 'This phone is signed out and everything Obscura stored on it is erased.', 'Unlink', true)
      : await confirm(`Unlink “${deviceLabel(device)}”?`, 'It is signed out of your account.', 'Unlink', true);
    if (!confirmed) return;
    try {
      await unlinkDevice(device);
      if (!device.isThisDevice) refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const thisDevice = devices?.find((d) => d.isThisDevice);

  return (
    <ScrollView style={s.container} contentContainerStyle={dv.screen} keyboardShouldPersistTaps="handled">
      <Text style={dv.sectionTitle}>your devices</Text>
      {loadError !== null && <Text style={dv.error}>{loadError}</Text>}
      {devices === null && loadError === null && <Text style={dv.hint}>Loading…</Text>}
      {devices?.map((device) => (
        <View key={device.deviceId} style={dv.row}>
          <View style={dv.info}>
            <Text style={dv.name}>{deviceLabel(device)}</Text>
            <View style={dv.badges}>
              {device.isPrimary && <Text style={[dv.badge, dv.primaryBadge]}>Primary</Text>}
              {device.isThisDevice && <Text style={dv.badge}>This device</Text>}
            </View>
          </View>
          {isPrimary === true && !device.isThisDevice && (
            <TouchableOpacity style={dv.unlinkBtn} onPress={() => unlink(device)}>
              <Text style={dv.unlinkText}>Unlink</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      {isPrimary === true && (<>
        <Text style={dv.sectionTitle}>link a device</Text>
        <Text style={dv.hint}>On the new device, log in to this account, then scan the code it shows.</Text>
        <TouchableOpacity style={dv.scanBtn} onPress={() => nav.navigate('ScanLink')}>
          <Text style={dv.scanBtnText}>Scan link code</Text>
        </TouchableOpacity>
        <View style={dv.enterRow}>
          <TextInput
            style={dv.input}
            placeholder="Or paste the code"
            placeholderTextColor={colors.textDim}
            value={codeInput}
            onChangeText={setCodeInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={dv.linkBtn} onPress={linkPasted}>
            <Text style={dv.linkBtnText}>Link</Text>
          </TouchableOpacity>
        </View>
      </>)}

      {isPrimary === false && (<>
        <Text style={dv.hint}>Devices are linked and unlinked from your primary device.</Text>
        {thisDevice && (
          <TouchableOpacity style={dv.dangerBtn} onPress={() => unlink(thisDevice)}>
            <Text style={dv.dangerBtnText}>Unlink this device</Text>
          </TouchableOpacity>
        )}
      </>)}
    </ScrollView>
  );
}

const dv = StyleSheet.create({
  screen: { padding: 16 },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8, textTransform: 'uppercase' },
  hint: { color: colors.textDim, fontSize: 14, marginBottom: 12 },
  error: { color: colors.error, fontSize: 14, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8 },
  info: { flex: 1 },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  badges: { flexDirection: 'row', gap: 6, marginTop: 4 },
  badge: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  primaryBadge: { color: colors.accent },
  unlinkBtn: { borderWidth: 1, borderColor: colors.error, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  unlinkText: { color: colors.error, fontWeight: '700', fontSize: 13 },
  scanBtn: {
    backgroundColor: colors.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 12,
  },
  scanBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 15 },
  enterRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: colors.text, fontSize: 15, borderWidth: 1, borderColor: colors.border,
  },
  linkBtn: { backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  linkBtnText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  dangerBtn: { borderWidth: 1, borderColor: colors.error, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 12 },
  dangerBtnText: { color: colors.error, fontWeight: '700', fontSize: 16 },
});
