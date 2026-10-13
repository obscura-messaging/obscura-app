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
import { clamp, touchDist } from '../utils/gesture';
import { FlashIcon, FlipCameraIcon } from '../components/icons';
import { CameraPermissionGate } from '../components/CameraPermissionGate';
import { MainHeaderOverlay } from '../components/MainHeaderOverlay';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

// Quick tap vs press-and-hold threshold for the shutter (ms).
const HOLD_TO_RECORD_MS = 220;

// Space the bottom controls clear of the floating tab bar. Small — enough to
// clear the tab bar but keep the shutter grounded near the bottom (a large gap
// made it look like it floated in dead space).
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

  // Keep the VisionCamera session live only while the record-camera tab is
  // actually on-screen and the app is foregrounded. MainTabs drives this via
  // CameraActiveContext (MainTabs-focused && app-active): it stays true across a
  // left/right tab swipe (so the preview slides in live, not black), but flips
  // false when a modal covers MainTabs — notably ScanFriend, which opens its
  // OWN camera and would otherwise collide with this one on CameraX — or when
  // the app backgrounds (screen lock), which is what fixes the black-preview-
  // after-unlock bug.
  const cameraActive = useCameraActive();

  // Cap to a sane 1080p30 format. Without this VisionCamera picks a 120fps HEVC
  // monster that makes the recording AssetWriter slow to start + huge files.
  // We downscale photos to 1080 before sending anyway, so this is lossless there.
  const format = useCameraFormat(device, [
    { fps: 30 },
    { videoResolution: { width: 1920, height: 1080 } },
    { photoResolution: { width: 1920, height: 1080 } },
  ]);

  // Warm the audio HAL so hold-to-record starts instantly (cold AVAudioSession
  // activation is ~1.4s on iOS). Warm on mount + re-warm after each recording,
  // since VisionCamera deactivates the session when a recording ends.
  const prewarmAudio = useCallback(() => {
    Obscura.prewarmAudioSession().catch((e) => logError('prewarmAudio', e));
  }, []);
  useEffect(() => { prewarmAudio(); }, [prewarmAudio]);

  // Latest values the (once-created) PanResponder closures read from.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const deviceRef = useRef(device);
  deviceRef.current = device;

  // Pinch-to-zoom gesture surface. Deliberately claims ONLY when a second
  // finger is down — a single-finger horizontal drag is left for the tab pager
  // (react-native-pager-view) so the swipe-to-Chats gesture tracks the finger.
  // Camera flip uses the FLIP button; a one-finger double-tap would conflict
  // with the pager swipe.
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
        // Establish the pinch baseline once the second finger is down.
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
    // VisionCamera returns a file:// URL on iOS; the rest of the pipeline (preview,
    // resizeImage, uploadAttachment) and the bridge contract expect a plain path.
    const path = photo.path.replace(/^file:\/\//, '');
    nav.navigate('PhotoPreview', {
      photo: { path, width: photo.width, height: photo.height },
      mediaType: 'photo',
    });
  }, [flash, nav]);

  // ─── Video: hold the shutter to record for as long as it's held ───────────
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);

  // Simple shutter-button press feedback: scale down on touch, spring back on
  // release. Native-driver so it's instant (<16ms) even while the ~440ms photo
  // capture runs on the JS/native bridge — the button acknowledges the tap
  // immediately instead of feeling unresponsive until the capture completes.
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
      // h264 for universal cross-platform playback (iOS defaults to HEVC, which
      // isn't as reliably decodable on Android). videoBitRate="low" on <Camera>
      // keeps the file small since we don't transcode.
      videoCodec: 'h264',
      onRecordingFinished: (video) => {
        setRecording(false);
        prewarmAudio(); // re-warm for the next record (VisionCamera just deactivated)
        const path = video.path.replace(/^file:\/\//, '');
        nav.navigate('PhotoPreview', {
          photo: { path, width: 0, height: 0 },
          mediaType: 'video',
        });
      },
      onRecordingError: (e) => { setRecording(false); prewarmAudio(); logError('record', e); },
    });
  }, [nav, prewarmAudio]);

  const stopRecording = useCallback(async () => {
    try { await camera.current?.stopRecording(); } catch (e) { logError('stopRecording', e); }
  }, []);

  // Press-in arms a hold timer; if held past the threshold we record, otherwise
  // the release fires a normal photo. Release always ends a recording.
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

  // Emulator fallback — native side synthesizes a JPEG so the rest of the
  // capture pipeline (resize / upload) sees the same shape as a real photo.
  const takeTestPhoto = useCallback(async () => {
    const img = await Obscura.writeTestImage(100, 100);
    nav.navigate('PhotoPreview', {
      photo: { path: img.path, width: img.width, height: img.height },
    });
  }, [nav]);

  // No camera device (the iOS simulator): render the real chrome over a placeholder so the layout
  // can be worked on, with the shutter producing the native test JPEG instead of a capture.
  const simulator = !device;

  const screen = (
      <View style={cs.container}>
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
          <View style={[StyleSheet.absoluteFill, cs.simPreview]}>
            <Text style={cs.simPreviewText}>No camera on this simulator</Text>
          </View>
        )}
        <MainHeaderOverlay camera={true} />

      {/* Pinch-zoom gesture surface. Claims only on a 2-finger move, so a
          single-finger horizontal drag falls through to the tab pager for the
          swipe-to-Chats transition. Below the controls overlay (box-none). */}
        <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      {/* Controls overlay. Bottom is padded clear of the transparent tab bar
          that floats over the full-bleed camera. */}
        <View style={cs.overlay} pointerEvents="box-none">
        {/* Bottom controls. Shutter is centered (the anchor); flash + flip
            flank it as icons. Kept out of the top strip because the transparent
            nav header sits on top there and would swallow the taps. */}
          <View style={[cs.bottomControls, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
            <View style={cs.controlsRow}>
              <TouchableOpacity style={cs.flashBtn} onPress={toggleFlash} accessibilityLabel="Toggle flash">
                <FlashIcon size={26} color={flash === 'on' ? colors.accent : '#fff'} on={flash === 'on'} />
              </TouchableOpacity>

              <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
                <Pressable
                  onPressIn={simulator ? () => animateShutter(0.88) : onShutterPressIn}
                  onPressOut={simulator ? () => { animateShutter(1); takeTestPhoto(); } : onShutterPressOut}
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
  );

  // The permission gate only makes sense when there is a camera to ask for.
  return simulator ? screen : (
    <CameraPermissionGate message="Camera access needed">{screen}</CameraPermissionGate>
  );
}

const cs = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  bottomControls: { paddingBottom: 16, paddingHorizontal: 24 },
  // Shutter centered as the anchor; flash + flip flank it symmetrically.
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
  simPreview: { backgroundColor: '#1c1c1e', justifyContent: 'center', alignItems: 'center' },
  simPreviewText: { color: '#555', fontSize: 14 },
  permissionContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  permissionBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  permissionBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
});
