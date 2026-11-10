import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission, useCodeScanner, type CameraPermissionStatus, type Code,
} from 'react-native-vision-camera';
import Svg, { Path } from 'react-native-svg';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseQR, type QRKind } from '../../domain/qr';
import { canPromptFor } from '../../state/permissions';
import { withAlpha } from '../theme';
import { useUi2Theme } from '../store';

interface QRScannerProps {
  kind: QRKind;
  hint: string;
  // claude: resolves true when the code is used up, false to keep scanning
  onCode: (code: string) => Promise<boolean>;
}

// claude: scanning and permission logic copied from src/components/QRScanner.tsx and CameraPermissionGate.tsx.
export function QRScanner({ kind, hint, onCode }: QRScannerProps) {
  const nav = useNavigation();
  const theme = useUi2Theme();
  const isFocused = useIsFocused();
  const insets = useSafeAreaInsets();
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [status, setStatus] = useState<CameraPermissionStatus | null>(null);
  const handled = useRef(false);

  const refresh = useCallback(() => setStatus(Camera.getCameraPermissionStatus()), []);
  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  const onCodeScanned = useCallback((codes: Code[]) => {
    if (handled.current) return;
    const code = codes.map(c => parseQR(kind, c.value)).find(c => c !== null);
    if (!code) return;
    handled.current = true;
    onCode(code).then(done => { handled.current = done; });
  }, [kind, onCode]);
  const codeScanner = useCodeScanner({ codeTypes: ['qr'], onCodeScanned });

  const close = (
    <TouchableOpacity
      style={[styles.close, { top: insets.top + 12, backgroundColor: withAlpha(theme.bar, 56) }]}
      onPress={() => nav.goBack()}
      accessibilityLabel="Close"
    >
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
        <Path d="M6 6l12 12M18 6L6 18" stroke={theme.barIcon} strokeWidth={2.6} strokeLinecap="round" />
      </Svg>
    </TouchableOpacity>
  );

  if (!hasPermission && status !== 'granted') {
    const canRequest = status !== null && canPromptFor(status);
    const request = async () => { await requestPermission(); refresh(); };
    return (
      <View style={[styles.center, { backgroundColor: theme.sky }]}>
        <Text style={[styles.message, { color: theme.onSecondary.ink }]}>Camera access needed to scan</Text>
        <TouchableOpacity
          style={[styles.gateBtn, { backgroundColor: theme.sun, borderColor: theme.onSecondary.outline }]}
          onPress={canRequest ? request : () => Linking.openSettings()}
          disabled={status === null}
        >
          <Text style={[styles.gateBtnText, { color: theme.sunInk }]}>
            {status === null ? 'Checking access…' : canRequest ? 'Grant access' : 'Open settings'}
          </Text>
        </TouchableOpacity>
        {close}
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.center, { backgroundColor: theme.sky }]}>
        <Text style={[styles.message, { color: theme.onSecondary.ink }]}>No camera available</Text>
        {close}
      </View>
    );
  }

  return (
    <View style={styles.camera}>
      <Camera style={StyleSheet.absoluteFill} device={device} isActive={isFocused} codeScanner={codeScanner} photo={true} />
      <View style={styles.overlay} pointerEvents="none">
        <View style={[styles.frame, { borderColor: theme.yellow }]} />
        <Text style={styles.hint}>{hint}</Text>
      </View>
      {close}
    </View>
  );
}

const styles = StyleSheet.create({
  camera: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  message: { fontSize: 18, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  gateBtn: { borderRadius: 999, borderWidth: 2, paddingHorizontal: 24, paddingVertical: 12 },
  gateBtnText: { fontSize: 15, fontWeight: '900' },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderRadius: 26, borderWidth: 5 },
  hint: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', marginTop: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  close: { position: 'absolute', left: 16, width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
});
