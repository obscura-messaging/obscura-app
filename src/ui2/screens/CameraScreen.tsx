import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import {
  Camera, type CameraPermissionStatus, useCameraDevice, useCameraFormat, useCameraPermission, useMicrophonePermission,
} from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCameraActive } from '../../navigation/CameraActiveContext';
import type { RootStackParamList } from '../../navigation/types';
import { createTestCapture, prewarmAudio } from '../../state/sendMedia';
import { canPromptFor } from '../../state/permissions';
import { logError } from '../../utils/log';
import { toPath } from '../../utils/files';
import { clamp, touchDist } from '../../utils/gesture';
import { withAlpha } from '../theme';
import { useUi2Theme } from '../store';
import { cameraShutter } from '../components/TabBar';

// claude: capture logic copied from src/screens/CameraScreen.tsx; only the chrome is new.
const HOLD_TO_RECORD_MS = 220;

export function CameraScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const theme = useUi2Theme();
  const insets = useSafeAreaInsets();
  const { hasPermission: hasMic } = useMicrophonePermission();
  const { hasPermission, requestPermission } = useCameraPermission();
  const [status, setStatus] = useState<CameraPermissionStatus | null>(null);
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [zoom, setZoom] = useState(1);
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(facing);
  const cameraActive = useCameraActive();

  const format = useCameraFormat(device, [
    { fps: 30 },
    { videoResolution: { width: 1920, height: 1080 } },
    { photoResolution: { width: 1920, height: 1080 } },
  ]);

  useEffect(() => { prewarmAudio(); }, []);

  const refreshPermission = useCallback(() => setStatus(Camera.getCameraPermissionStatus()), []);
  useEffect(() => {
    refreshPermission();
    const sub = AppState.addEventListener('change', next => { if (next === 'active') refreshPermission(); });
    return () => sub.remove();
  }, [refreshPermission]);

  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const deviceRef = useRef(device);
  deviceRef.current = device;

  const gesture = useRef({ startDist: 0, startZoom: 1 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: e => e.nativeEvent.touches.length === 2,
      onPanResponderMove: e => {
        const touches = e.nativeEvent.touches;
        if (touches.length !== 2) return;
        const dev = deviceRef.current;
        if (!dev) return;
        if (!gesture.current.startDist) {
          gesture.current.startDist = touchDist(touches);
          gesture.current.startZoom = zoomRef.current;
          return;
        }
        const ratio = touchDist(touches) / gesture.current.startDist;
        setZoom(clamp(gesture.current.startZoom * ratio, dev.minZoom, dev.maxZoom));
      },
      onPanResponderRelease: () => { gesture.current.startDist = 0; },
      onPanResponderTerminate: () => { gesture.current.startDist = 0; },
    }),
  ).current;

  const takePhoto = useCallback(async () => {
    if (!camera.current) return;
    try {
      const photo = await camera.current.takePhoto({ flash });
      nav.navigate('PhotoPreview', { path: toPath(photo.path), mediaType: 'photo' });
    } catch (e) {
      logError('takePhoto', e);
    }
  }, [flash, nav]);

  const startRecording = useCallback(() => {
    if (!camera.current) return;
    camera.current.startRecording({
      videoCodec: 'h264',
      onRecordingFinished: video => {
        prewarmAudio();
        nav.navigate('PhotoPreview', { path: toPath(video.path), mediaType: 'video' });
      },
      onRecordingError: e => { prewarmAudio(); logError('record', e); },
    });
  }, [nav]);

  const stopRecording = useCallback(async () => {
    try { await camera.current?.stopRecording(); } catch (e) { logError('stopRecording', e); }
  }, []);

  const takeTestPhoto = useCallback(async () => {
    try {
      const path = await createTestCapture();
      nav.navigate('PhotoPreview', { path, mediaType: 'photo' });
    } catch (e) {
      logError('takeTestPhoto', e);
    }
  }, [nav]);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);
  const simulator = !device;

  useEffect(() => {
    cameraShutter.pressIn = () => {
      if (simulator) return;
      didRecord.current = false;
      holdTimer.current = setTimeout(() => { didRecord.current = true; startRecording(); }, HOLD_TO_RECORD_MS);
    };
    cameraShutter.pressOut = () => {
      if (simulator) { takeTestPhoto(); return; }
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
      if (didRecord.current) stopRecording();
      else takePhoto();
    };
  }, [simulator, startRecording, stopRecording, takePhoto, takeTestPhoto]);

  const flipCamera = () => { setFacing(f => (f === 'back' ? 'front' : 'back')); setZoom(1); };
  const toggleFlash = () => setFlash(f => (f === 'off' ? 'on' : 'off'));

  const toolStyle = [styles.tool, { backgroundColor: withAlpha(theme.bar, 56) }];
  const ink = theme.barIcon;

  if (!simulator && !hasPermission && status !== 'granted') {
    const canRequest = status !== null && canPromptFor(status);
    const request = async () => { await requestPermission(); refreshPermission(); };
    return (
      <View style={[styles.screen, styles.gate]}>
        <Text style={[styles.gateText, { color: theme.onSecondary.white }]}>Camera access needed</Text>
        <TouchableOpacity
          style={[styles.gateBtn, { backgroundColor: theme.yellow }]}
          onPress={canRequest ? request : () => Linking.openSettings()}
          disabled={status === null}
        >
          <Text style={[styles.gateBtnText, { color: theme.sunInk }]}>{canRequest ? 'Grant access' : 'Open settings'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {device ? (
        <Camera
          ref={camera}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          isActive={cameraActive}
          photo={true}
          video={true}
          audio={hasMic}
          fps={30}
          videoBitRate="low"
          photoQualityBalance="speed"
          zoom={zoom}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.gate]}>
          <Text style={styles.simText}>No camera on this simulator</Text>
        </View>
      )}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      <View style={[styles.tools, { top: insets.top + 6 }]}>
        <TouchableOpacity style={toolStyle} onPress={toggleFlash} accessibilityLabel="Flash">
          <Svg width={22} height={22} viewBox="0 0 24 24">
            <Path d="M13 2 4 14h7l-1 8 9-12h-7z" fill={flash === 'on' ? theme.yellow : ink} />
          </Svg>
        </TouchableOpacity>
        <TouchableOpacity style={toolStyle} onPress={flipCamera} accessibilityLabel="Flip camera">
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
            <Path
              d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"
              stroke={ink} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"
            />
          </Svg>
        </TouchableOpacity>
        <TouchableOpacity style={toolStyle} accessibilityLabel="Face filters">
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
            <Circle cx="11" cy="13" r="8" stroke={ink} strokeWidth={2.2} />
            <Path d="M7.5 15.5a4.5 4.5 0 0 0 7 0" stroke={ink} strokeWidth={2.2} strokeLinecap="round" />
            <Circle cx="8.5" cy="11" r=".9" fill={ink} />
            <Circle cx="13.5" cy="11" r=".9" fill={ink} />
            <Path d="M19.5 1.5v4M17.5 3.5h4" stroke={ink} strokeWidth={2} strokeLinecap="round" />
          </Svg>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  tools: { position: 'absolute', right: 14, gap: 12 },
  tool: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  gate: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  gateText: { fontSize: 18, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  gateBtn: { borderRadius: 999, paddingHorizontal: 24, paddingVertical: 12 },
  gateBtnText: { fontSize: 15, fontWeight: '900' },
  simText: { color: '#555', fontSize: 14 },
});
