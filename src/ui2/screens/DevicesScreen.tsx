import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, TouchableOpacity, Text, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { deviceLabel, errorMessage } from '../../domain/devices';
import { loadDevices, unlinkDevice, type DeviceInfo } from '../../state/devices';
import { useSession } from '../../state/store';
import { toast } from '../../state/toast';
import type { RootStackParamList } from '../../navigation/types';
import { useUi2Theme } from '../store';
import { confirm, confirmAndApproveLink } from '../confirm';
import { Hint, InfoRow, Note, Page, PillButton, PillInput, SectionLabel } from '../components/Page';

// claude: the rules are the old DevicesScreen's; only the look is new.
export function DevicesScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const focused = useIsFocused();
  const { isPrimary } = useSession();
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const refresh = useCallback(() => {
    loadDevices()
      .then(list => { setDevices(list); setLoadError(null); })
      .catch(e => setLoadError(errorMessage(e)));
  }, []);
  useEffect(() => { if (focused) refresh(); }, [focused, refresh]);

  const linkPasted = async () => {
    if (await confirmAndApproveLink(code)) {
      setCode('');
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

  const thisDevice = devices?.find(d => d.isThisDevice);
  return (
    <Page title="Devices">
      <SectionLabel>Your devices</SectionLabel>
      {loadError !== null && <Hint danger>{loadError}</Hint>}
      {devices === null && loadError === null && <Hint>Loading…</Hint>}
      {devices?.map(device => {
        const tags = [device.isPrimary && 'Primary', device.isThisDevice && 'This device'].filter(Boolean).join(' · ');
        return (
          <InfoRow key={device.deviceId} label={deviceLabel(device)}>
            {tags !== '' && <Note>{tags}</Note>}
            {isPrimary === true && !device.isThisDevice && (
              <TouchableOpacity onPress={() => unlink(device)} accessibilityLabel={`Unlink ${deviceLabel(device)}`}>
                <Text style={[styles.unlink, { color: theme.alert }]}>Unlink</Text>
              </TouchableOpacity>
            )}
          </InfoRow>
        );
      })}

      {isPrimary === true && (
        <>
          <SectionLabel>Link a device</SectionLabel>
          <Hint>On the new device, log in to this account, then scan the code it shows.</Hint>
          <PillButton label="Scan link code" onPress={() => nav.navigate('ScanLink')} />
          <View style={styles.enter}>
            <PillInput placeholder="Or paste the code" value={code} onChangeText={setCode} />
            <PillButton label="Link" tone="plain" onPress={linkPasted} />
          </View>
        </>
      )}

      {isPrimary === false && (
        <>
          <Hint>Devices are linked and unlinked from your primary device.</Hint>
          {thisDevice && <PillButton label="Unlink this device" tone="danger" onPress={() => unlink(thisDevice)} />}
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  unlink: { fontSize: 13, fontWeight: '900' },
  enter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
