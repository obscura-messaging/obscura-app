import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { toast } from '../components/Toast';
import { confirm, confirmAndApproveLink } from '../components/confirm';
import { deviceLabel } from '../domain/devices';
import { errorMessage } from '../domain/errors';
import { loadDevices, unlinkDevice, type DeviceInfo } from '../state/devices';
import { useSignedIn } from '../state/store';
import type { RootStackParamList } from '../navigation/types';
import { s, colors } from '../styles';

export function DevicesScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { role } = useSignedIn();
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
    <ScrollView
      style={s.container}
      contentContainerStyle={[dv.screen, { paddingBottom: insets.bottom + 24 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.sectionTitle}>your devices</Text>
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
          {role === 'primary' && !device.isThisDevice && (
            <TouchableOpacity style={dv.unlinkBtn} onPress={() => unlink(device)}>
              <Text style={dv.unlinkText}>Unlink</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      {role === 'primary' && (<>
        <Text style={s.sectionTitle}>link a device</Text>
        <Text style={dv.hint}>On the new device, log in to this account, then scan the code it shows.</Text>
        <TouchableOpacity style={[s.primaryBtn, dv.scanBtn]} onPress={() => nav.navigate('ScanLink')}>
          <Text style={s.primaryBtnText}>Scan link code</Text>
        </TouchableOpacity>
        <View style={dv.enterRow}>
          <TextInput
            style={[s.input, dv.input]}
            placeholder="Or paste the code"
            placeholderTextColor={colors.textDim}
            value={codeInput}
            onChangeText={setCodeInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={s.secondaryBtn} onPress={linkPasted}>
            <Text style={s.secondaryBtnText}>Link</Text>
          </TouchableOpacity>
        </View>
      </>)}

      {role === 'linked' && (<>
        <Text style={dv.hint}>Devices are linked and unlinked from your primary device.</Text>
        {thisDevice && (
          <TouchableOpacity style={[s.dangerBtn, dv.dangerMargin]} onPress={() => unlink(thisDevice)}>
            <Text style={s.dangerBtnText}>Unlink this device</Text>
          </TouchableOpacity>
        )}
      </>)}
    </ScrollView>
  );
}

const dv = StyleSheet.create({
  screen: { padding: 16 },
  hint: { color: colors.textDim, fontSize: 14, marginBottom: 12 },
  error: { color: colors.error, fontSize: 14, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  info: { flex: 1 },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  badges: { flexDirection: 'row', gap: 6, marginTop: 4 },
  badge: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  primaryBadge: { color: colors.accent },
  unlinkBtn: { borderWidth: 1, borderColor: colors.error, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  unlinkText: { color: colors.error, fontWeight: '700', fontSize: 13 },
  scanBtn: { marginBottom: 12 },
  enterRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, marginBottom: 0 },
  dangerMargin: { marginTop: 12 },
});
