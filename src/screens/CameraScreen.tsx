import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, PanResponder, Animated, Platform } from 'react-native';
import {
  Camera, useCameraDevice, useCameraFormat, useMicrophonePermission,
} from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Obscura } from '../native/ObscuraModule';
import { useCameraActive } from '../navigation/CameraActiveContext';
import { logError } from '../utils/log';
import { toPath } from '../utils/files';
import { clamp, touchDist } from '../utils/gesture';
import { FlashIcon, FlipCameraIcon } from '../components/icons';
import { CameraPermissionGate } from '../components/CameraPermissionGate';
import { MainHeaderOverlay } from '../components/MainHeaderOverlay';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

/** Holding the shutter longer than this records video instead of taking a photo. */
const HOLD_TO_RECORD_MS = 220;

/** Keeps the controls clear of the floating tab bar. */
const TAB_BAR_CLEARANCE = Platform.OS === 'ios' ? 96 : 80;

export function CameraScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hasPermission: hasMic } = useMicrophonePermission();
  const insets = useSafeAreaInsets();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [zoom, setZoom] = useState(1);
  const [recording, setRecording] = useState(false);
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(facing);

  const cameraActive = useCameraActive();

  // Without a cap VisionCamera picks a 120 fps format: slow to start recording, huge files.
  const format = useCameraFormat(device, [
    { fps: 30 },
    { videoResolution: { width: 1920, height: 1080 } },
    { photoResolution: { width: 1920, height: 1080 } },
  ]);

  // Re-warmed after each recording, because VisionCamera deactivates the audio session.
  const prewarmAudio = useCallback(() => {
    Obscura.prewarmAudioSession().catch((e) => logError('prewarmAudio', e));
  }, []);
  useEffect(() => { prewarmAudio(); }, [prewarmAudio]);

  // Read by the PanResponder, which is created once.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const deviceRef = useRef(device);
  deviceRef.current = device;

  // Pinch to zoom. Claims only two-finger moves so one-finger swipes reach the tab pager.
  const gesture = useRef({ startDist: 0, startZoom: 1 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
      onPanResponderMove: (e) => {
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
    const photo = await camera.current.takePhoto({ flash });
    nav.navigate('PhotoPreview', { path: toPath(photo.path), mediaType: 'photo' });
  }, [flash, nav]);

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);

  // Native-driven so the press shows while the capture is still running.
  const shutterScale = useRef(new Animated.Value(1)).current;
  const animateShutter = useCallback((to: number) => {
    Animated.spring(shutterScale, {
      toValue: to, useNativeDriver: true, speed: 40, bounciness: 6,
    }).start();
  }, [shutterScale]);

  const startRecording = useCallback(() => {
    if (!camera.current) return;
    setRecording(true);
    camera.current.startRecording({
      // iOS defaults to HEVC, which Android does not reliably decode.
      videoCodec: 'h264',
      onRecordingFinished: (video) => {
        setRecording(false);
        prewarmAudio();
        nav.navigate('PhotoPreview', { path: toPath(video.path), mediaType: 'video' });
      },
      onRecordingError: (e) => { setRecording(false); prewarmAudio(); logError('record', e); },
    });
  }, [nav, prewarmAudio]);

  const stopRecording = useCallback(async () => {
    try { await camera.current?.stopRecording(); } catch (e) { logError('stopRecording', e); }
  }, []);

  const onShutterPressIn = () => {
    animateShutter(0.88);
    didRecord.current = false;
    holdTimer.current = setTimeout(() => { didRecord.current = true; startRecording(); }, HOLD_TO_RECORD_MS);
  };
  const onShutterPressOut = () => {
    animateShutter(1);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (didRecord.current) stopRecording();
    else takePhoto();
  };

  const flipCamera = () => {
    setFacing(f => f === 'back' ? 'front' : 'back');
    setZoom(1);
  };
  const toggleFlash = () => setFlash(f => f === 'off' ? 'on' : 'off');

  // Emulators without a camera get a synthesized JPEG.
  const takeTestPhoto = useCallback(async () => {
    const img = await Obscura.writeTestImage(100, 100);
    nav.navigate('PhotoPreview', { path: img.path, mediaType: 'photo' });
  }, [nav]);

  if (!device) {
    return (
      <View style={cs.permissionContainer}>
        <Text style={cs.permissionText}>No camera available</Text>
        <Text style={cs.hint}>Simulator mode — tap to use test photo</Text>
        <TouchableOpacity style={cs.permissionBtn} onPress={takeTestPhoto}>
          <Text style={cs.permissionBtnText}>Use test photo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <CameraPermissionGate message="Camera access needed">
      <View style={cs.container}>
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
        <MainHeaderOverlay camera={true} />

        <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

        <View style={cs.overlay} pointerEvents="box-none">
          <View style={[cs.bottomControls, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
            <View style={cs.controlsRow}>
              <TouchableOpacity style={cs.flashBtn} onPress={toggleFlash} accessibilityLabel="Toggle flash">
                <FlashIcon size={26} color={flash === 'on' ? colors.accent : '#fff'} on={flash === 'on'} />
              </TouchableOpacity>

              <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
                <Pressable
                  onPressIn={onShutterPressIn}
                  onPressOut={onShutterPressOut}
                  style={[cs.captureBtn, recording && cs.captureBtnActive]}
                  accessibilityLabel="Capture"
                >
                  <View style={[cs.captureBtnInner, recording && cs.captureBtnInnerActive]} />
                </Pressable>
              </Animated.View>

              <TouchableOpacity style={cs.flipBtn} onPress={flipCamera} accessibilityLabel="Flip camera">
                <FlipCameraIcon size={30} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </CameraPermissionGate>
  );
}

const cs = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  bottomControls: { paddingBottom: 16, paddingHorizontal: 24 },
  controlsRow: { alignItems: 'center', justifyContent: 'center' },
  flashBtn: {
    position: 'absolute', left: 8, width: 52, height: 52,
    borderRadius: 26, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  flipBtn: {
    position: 'absolute', right: 8, width: 52, height: 52,
    borderRadius: 26, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  captureBtn: {
    width: 84, height: 84, borderRadius: 42, borderWidth: 5,
    borderColor: '#fff', justifyContent: 'center', alignItems: 'center',
  },
  captureBtnActive: { borderColor: colors.error },
  captureBtnInner: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#fff' },
  captureBtnInnerActive: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.error },
  permissionContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  permissionBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  permissionBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
});
