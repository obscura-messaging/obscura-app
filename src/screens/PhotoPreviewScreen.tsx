import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, TouchableWithoutFeedback, Image,
  StyleSheet, KeyboardAvoidingView, Keyboard, Platform, Animated, PanResponder,
  useWindowDimensions,
} from 'react-native';
import Video from 'react-native-video';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { colors } from '../styles';
import { CloseIcon } from '../components/icons';
import { clamp, touchDist } from '../utils/gesture';
import {
  CAPTION_FONTS, CAPTION_FONT_LABELS, CAPTION_COLORS, DEFAULT_BAR, captionStyles, boldTextStyle,
  serializeCaptionMeta, type CaptionMeta, type CaptionStyle,
} from '../components/Caption';
import { DEFAULT_DISPLAY_SECONDS } from '../domain/pix';
import { fileUri } from '../utils/files';

const TIMER_OPTIONS = [
  { label: '3s', value: 3 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: 'no limit', value: 0 },
];

/** Releasing a dragged caption above this y (px) deletes it. */
const DELETE_Y = 130;
const CAPTION_MAX_LENGTH = 100;

export function PhotoPreviewScreen({ route }: RootStackScreenProps<'PhotoPreview'>) {
  const { path, mediaType } = route.params;
  const isVideo = mediaType === 'video';
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [caption, setCaption] = useState('');
  const [duration, setDuration] = useState(DEFAULT_DISPLAY_SECONDS);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [style, setStyle] = useState<CaptionStyle>('bar');
  const [fontIdx, setFontIdx] = useState(0);
  const [colorIdx, setColorIdx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [nearDelete, setNearDelete] = useState(false);
  const nearDeleteRef = useRef(false);

  // The caption's transform, animated for rendering and mirrored into refs to read at send time.
  const initialBarY = DEFAULT_BAR.y * H;
  const barY = useRef(new Animated.Value(initialBarY)).current;
  const boldPan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current; // px from the screen center
  const boldRot = useRef(new Animated.Value(0)).current; // radians
  const boldScale = useRef(new Animated.Value(1)).current;
  const barYVal = useRef(initialBarY);
  const boldPanVal = useRef({ x: 0, y: 0 });
  const boldRotVal = useRef(0);
  const boldScaleVal = useRef(1);

  useEffect(() => {
    const a = barY.addListener(({ value }) => { barYVal.current = value; });
    const b = boldPan.addListener((v) => { boldPanVal.current = v; });
    const c = boldRot.addListener(({ value }) => { boldRotVal.current = value; });
    const d = boldScale.addListener(({ value }) => { boldScaleVal.current = value; });
    return () => {
      barY.removeListener(a); boldPan.removeListener(b);
      boldRot.removeListener(c); boldScale.removeListener(d);
    };
  }, [barY, boldPan, boldRot, boldScale]);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardUp(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => { setKeyboardUp(false); setEditing(false); },
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const deleteCaption = () => {
    setCaption('');
    setStyle('bar');
    setFontIdx(0);
    setColorIdx(0);
    barY.setValue(initialBarY);
    boldPan.setValue({ x: 0, y: 0 });
    boldRot.setValue(0);
    boldScale.setValue(1);
    setEditing(false);
  };

  const hoverDelete = (yPx: number) => {
    const near = yPx < DELETE_Y;
    if (near !== nearDeleteRef.current) { nearDeleteRef.current = near; setNearDelete(near); }
  };
  const endDrag = (wasTap: boolean) => {
    setDragging(false);
    if (nearDeleteRef.current) { nearDeleteRef.current = false; setNearDelete(false); deleteCaption(); return; }
    if (wasTap) setEditing(true);
  };

  // Bar caption: drag vertically; a tap re-edits.
  const barMoved = useRef(false);
  const barStartY = useRef(0);
  const barPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { barStartY.current = barYVal.current; barMoved.current = false; setDragging(true); },
    onPanResponderMove: (_e, gs) => {
      if (Math.abs(gs.dy) > 4) barMoved.current = true;
      const top = clamp(barStartY.current + gs.dy, 60, H - 140);
      barY.setValue(top);
      hoverDelete(top);
    },
    onPanResponderRelease: () => endDrag(!barMoved.current),
  })).current;

  // Bold caption: one finger pans, two pinch and rotate; a tap re-edits.
  const boldMoved = useRef(false);
  const boldStart = useRef({
    x: 0, y: 0, rot: 0, angle: 0, scale: 1, dist: 0, mode: '' as '' | 'pan' | 'pinch',
  });
  const boldPanResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      boldStart.current = {
        x: boldPanVal.current.x, y: boldPanVal.current.y,
        rot: boldRotVal.current, angle: 0, scale: boldScaleVal.current, dist: 0, mode: '',
      };
      boldMoved.current = false;
      setDragging(true);
    },
    onPanResponderMove: (e, gs) => {
      const touches = e.nativeEvent.touches;
      if (touches.length >= 2) {
        const ang = Math.atan2(touches[1].pageY - touches[0].pageY, touches[1].pageX - touches[0].pageX);
        const dist = touchDist(touches);
        if (boldStart.current.mode !== 'pinch') {
          boldStart.current.mode = 'pinch';
          boldStart.current.angle = ang;
          boldStart.current.rot = boldRotVal.current;
          boldStart.current.dist = dist;
          boldStart.current.scale = boldScaleVal.current;
        }
        boldRot.setValue(boldStart.current.rot + (ang - boldStart.current.angle));
        if (boldStart.current.dist > 0) {
          boldScale.setValue(clamp(boldStart.current.scale * (dist / boldStart.current.dist), 0.4, 5));
        }
        boldMoved.current = true;
      } else {
        if (boldStart.current.mode !== 'pan') {
          boldStart.current.mode = 'pan';
          boldStart.current.x = boldPanVal.current.x - gs.dx;
          boldStart.current.y = boldPanVal.current.y - gs.dy;
        }
        const offsetY = boldStart.current.y + gs.dy;
        boldPan.setValue({ x: boldStart.current.x + gs.dx, y: offsetY });
        if (Math.abs(gs.dx) + Math.abs(gs.dy) > 6) boldMoved.current = true;
        hoverDelete(H / 2 + offsetY);
      }
    },
    onPanResponderRelease: () => endDrag(!boldMoved.current),
  })).current;

  const rotateStr = boldRot.interpolate({
    inputRange: [-Math.PI, Math.PI], outputRange: ['-180deg', '180deg'], extrapolate: 'extend',
  });

  const boldLook = { font: fontIdx, color: CAPTION_COLORS[colorIdx] };
  const hasCaption = caption.trim().length > 0;

  const cycleFont = () => setFontIdx(i => (i + 1) % CAPTION_FONTS.length);

  const buildMeta = (): CaptionMeta | null => {
    if (!hasCaption) return null;
    if (style === 'bar') return { style: 'bar', y: clamp(barYVal.current / H, 0, 1) };
    return {
      style: 'bold',
      x: clamp(0.5 + boldPanVal.current.x / W, 0, 1),
      y: clamp(0.5 + boldPanVal.current.y / H, 0, 1),
      rot: boldRotVal.current,
      scale: boldScaleVal.current,
      color: CAPTION_COLORS[colorIdx],
      font: fontIdx,
    };
  };

  const onChoose = () => {
    const meta = buildMeta();
    nav.navigate('RecipientPicker', {
      path,
      mediaType,
      caption: caption.trim(),
      captionMeta: meta ? serializeCaptionMeta(meta) : undefined,
      displayDuration: duration,
    });
  };

  return (
    <View style={ps.container}>
      {/* A tap on the media starts a caption, or dismisses the keyboard. */}
      <TouchableWithoutFeedback
        onPress={() => { if (editing) Keyboard.dismiss(); else setEditing(true); }}
        accessible={false}
      >
        {isVideo ? (
          <Video source={{ uri: fileUri(path) }} style={StyleSheet.absoluteFill} resizeMode="cover" repeat />
        ) : (
          <Image
            source={{ uri: fileUri(path) }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            fadeDuration={0}
          />
        )}
      </TouchableWithoutFeedback>

      {hasCaption && !editing && style === 'bar' && (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          <Animated.View
            {...barPan.panHandlers}
            style={[captionStyles.barWrap, ps.barPos, { top: barY }]}
          >
            <Text style={captionStyles.barText}>{caption}</Text>
          </Animated.View>
        </View>
      )}
      {hasCaption && !editing && style === 'bold' && (
        <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, ps.center]}>
          <Animated.Text
            {...boldPanResponder.panHandlers}
            style={[
              boldTextStyle(boldLook),
              { transform: [{ translateX: boldPan.x }, { translateY: boldPan.y }, { rotate: rotateStr }, { scale: boldScale }] },
            ]}
          >
            {caption}
          </Animated.Text>
        </View>
      )}

      {editing && style === 'bold' && (
        <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, ps.center]}>
          <TextInput
            style={[boldTextStyle(boldLook), ps.boldInput]}
            value={caption}
            onChangeText={setCaption}
            placeholder="Type…"
            placeholderTextColor="rgba(255,255,255,0.5)"
            autoFocus
            multiline
            textAlign="center"
            maxLength={CAPTION_MAX_LENGTH}
          />
        </View>
      )}
      {editing && style === 'bar' && (
        <KeyboardAvoidingView
          style={ps.kavRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
        >
          <View style={ps.spacer} pointerEvents="none" />
          <View style={[captionStyles.barWrap, ps.barEditWrap]}>
            <TextInput
              style={captionStyles.barText}
              value={caption}
              onChangeText={setCaption}
              placeholder="Add a caption…"
              placeholderTextColor="#bbb"
              autoFocus
              multiline
              textAlign="center"
              maxLength={CAPTION_MAX_LENGTH}
            />
          </View>
        </KeyboardAvoidingView>
      )}

      <View style={[ps.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <TouchableOpacity onPress={() => nav.goBack()} style={ps.retakeBtn}>
          <CloseIcon size={20} color="#fff" />
        </TouchableOpacity>

        <View style={ps.toolCol}>
          {(hasCaption || editing) && (
            <View style={ps.segment}>
              {(['bar', 'bold'] as CaptionStyle[]).map(s => (
                <TouchableOpacity
                  key={s}
                  style={[ps.segBtn, style === s && ps.segBtnActive]}
                  onPress={() => setStyle(s)}
                >
                  <Text style={[ps.segText, style === s && ps.segTextActive]}>{s.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {editing && style === 'bold' && (
            <TouchableOpacity style={ps.toolBtn} onPress={cycleFont}>
              <Text style={[ps.toolBtnText, { fontFamily: CAPTION_FONTS[fontIdx] }]}>
                {CAPTION_FONT_LABELS[fontIdx]}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {dragging && (
        <View style={ps.deleteZone} pointerEvents="none">
          <View style={[ps.deletePill, nearDelete && ps.deletePillActive]}>
            <Text style={ps.deleteIcon}>{'✕'}</Text>
            <Text style={ps.deleteLabel}>{nearDelete ? 'Release to delete' : 'Drag here to delete'}</Text>
          </View>
        </View>
      )}

      {editing && style === 'bold' && (
        <View style={ps.colorStrip} pointerEvents="box-none">
          {CAPTION_COLORS.map((c, i) => (
            <TouchableOpacity
              key={c}
              onPress={() => setColorIdx(i)}
              style={[ps.swatch, { backgroundColor: c }, i === colorIdx && ps.swatchActive]}
            />
          ))}
        </View>
      )}

      {!keyboardUp && (
        <View style={ps.bottom} pointerEvents="box-none">
          <View style={ps.timerRow}>
            {TIMER_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[ps.timerBtn, duration === opt.value && ps.timerBtnActive]}
                onPress={() => setDuration(opt.value)}
              >
                <Text style={[ps.timerText, duration === opt.value && ps.timerTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={ps.sendBtn} onPress={onChoose}>
            <Text style={ps.sendBtnText}>choose recipients</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    padding: 16, zIndex: 2,
  },
  retakeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  toolCol: { alignItems: 'flex-end', gap: 10 },
  toolBtn: {
    minWidth: 44, height: 40, paddingHorizontal: 10, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  toolBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  segment: { flexDirection: 'row', borderRadius: 20, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.5)' },
  segBtn: { paddingHorizontal: 14, height: 40, justifyContent: 'center', alignItems: 'center' },
  segBtnActive: { backgroundColor: colors.accent },
  segText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  segTextActive: { color: colors.onAccent },
  deleteZone: { position: 'absolute', top: 44, left: 0, right: 0, alignItems: 'center', zIndex: 3 },
  deletePill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  deletePillActive: { backgroundColor: colors.error, borderColor: '#fff', transform: [{ scale: 1.1 }] },
  deleteIcon: { color: '#fff', fontSize: 16, fontWeight: '900' },
  deleteLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },
  barPos: { position: 'absolute', left: 0, right: 0 },
  barEditWrap: { marginBottom: 12 },
  boldInput: { minWidth: 200, paddingHorizontal: 12 },
  colorStrip: {
    position: 'absolute', right: 12, top: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center', gap: 12, zIndex: 2,
  },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'rgba(255,255,255,0.4)' },
  swatchActive: { borderColor: '#fff', transform: [{ scale: 1.25 }] },
  kavRoot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  spacer: { flex: 1 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingBottom: 40 },
  timerRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 16 },
  timerBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.15)' },
  timerBtnActive: { backgroundColor: colors.accent },
  timerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  timerTextActive: { color: colors.onAccent },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  sendBtnText: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
});
