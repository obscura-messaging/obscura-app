import React, { useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import {
  Camera, useCameraDevice, useCodeScanner,
} from 'react-native-vision-camera';
import type { Code } from 'react-native-vision-camera';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { CloseIcon } from '../components/icons';
import { CameraPermissionGate } from '../components/CameraPermissionGate';
import { parseFriendQR } from '../domain/friendQR';
import { errorMessage } from '../utils/log';
import type { RootStackParamList } from '../navigation/types';

/** Its own screen: VisionCamera cannot run a code scanner alongside the record camera's video output. */
export function ScanFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const isFocused = useIsFocused();
  const device = useCameraDevice('back');
  const handled = useRef(false); // onCodeScanned keeps firing

  const onCodeScanned = useCallback((codes: Code[]) => {
    if (handled.current) return;
    for (const c of codes) {
      const code = parseFriendQR(c.value);
      if (!code) continue;
      handled.current = true;
      Obscura.addFriendByCode(code)
        .then(() => { toast.success('Friend request sent'); nav.goBack(); })
        .catch((e) => { toast.error(errorMessage(e)); handled.current = false; });
      return;
    }
  }, [nav]);

  const codeScanner = useCodeScanner({ codeTypes: ['qr'], onCodeScanned });

  return (
    <CameraPermissionGate message="Camera access needed to scan">
      {!device ? (
        <View style={ss.center}><Text style={ss.msg}>No camera available</Text></View>
      ) : (
        <View style={ss.container}>
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={isFocused}
            codeScanner={codeScanner}
            photo={true}
          />
          <View style={ss.overlay} pointerEvents="box-none">
            <View style={ss.frame} />
            <Text style={ss.hint}>Point at a friend's QR code</Text>
          </View>
          <TouchableOpacity style={ss.close} onPress={() => nav.goBack()}>
            <CloseIcon size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </CameraPermissionGate>
  );
}

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  msg: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16, textAlign: 'center' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  frame: {
    width: 240, height: 240, borderRadius: 24,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)',
  },
  hint: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  close: {
    position: 'absolute', top: 48, left: 16, width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
});
