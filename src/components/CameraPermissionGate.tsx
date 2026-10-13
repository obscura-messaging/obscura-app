import React, { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  Camera, type CameraPermissionStatus, useCameraPermission,
} from 'react-native-vision-camera';
import { canPromptFor } from '../application/requestStartupPermissions';
import { colors } from '../styles';

interface CameraPermissionGateProps {
  children: ReactNode;
  message: string;
}

export function CameraPermissionGate({ children, message }: CameraPermissionGateProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [status, setStatus] = useState<CameraPermissionStatus | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await Camera.getCameraPermissionStatus());
  }, []);

  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const request = useCallback(async () => {
    await requestPermission();
    await refresh();
  }, [refresh, requestPermission]);

  if (hasPermission || status === 'granted') return children;

  const canRequest = status !== null && canPromptFor(status);
  return (
    <View style={s.container}>
      <Text style={s.message}>{message}</Text>
      <TouchableOpacity
        style={s.button}
        onPress={canRequest ? request : () => Linking.openSettings()}
        disabled={status === null}
      >
        <Text style={s.buttonText}>
          {status === null ? 'Checking access…' : canRequest ? 'Grant access' : 'Open settings'}
        </Text>
      </TouchableOpacity>
      {!canRequest && status !== null && (
        <Text style={s.hint}>Enable camera access in Settings.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  message: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  buttonText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  hint: { color: '#aaa', fontSize: 14, marginTop: 12, textAlign: 'center' },
});
