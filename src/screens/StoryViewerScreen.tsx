import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, Easing, Image, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import { CaptionView, parseCaptionMeta } from '../components/Caption';
import { CloseIcon } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { attachmentOf, displayMs, type Attachment } from '../domain/pix';
import { storyGroups, type StoryGroup } from '../domain/stories';
import { stepViewer } from '../domain/viewer';
import { loadAttachmentUri } from '../state/sendMedia';
import { useIdentity, useModelEntries, markSeen } from '../state/store';
import { timeAgo } from '../utils/format';
import { logError } from '../utils/log';
import type { RootStackScreenProps, ViewerEntry } from '../navigation/types';
import { colors } from '../styles';

/** How long one turn of the 3D cube transition takes. */
const CUBE_MS = 300;
/** Perspective distance as a multiple of the screen width. Larger is flatter. */
const CUBE_PERSPECTIVE = 2;

/**
 * Turn a full-screen face by `angle` about a vertical axis half a screen behind the screen centre:
 * one face of a cube as wide as the screen. At 0deg the face is flat; at -90deg it is edge-on at
 * the left; at 90deg edge-on at the right. React Native has no translateZ, so the depth offset is a
 * translateX wrapped in quarter turns: Tz(d) = Ry(90) Tx(-d) Ry(-90).
 */
function cubeFace(width: number, angle: Animated.AnimatedInterpolation<string>) {
  return [
    { perspective: width * CUBE_PERSPECTIVE },
    { rotateY: '90deg' },
    { translateX: width / 2 },
    { rotateY: angle },
    { translateX: -width / 2 },
    { rotateY: '-90deg' },
  ];
}

/** A group's story as it was when the cube started turning. */
interface Face { group: StoryGroup<ViewerEntry>; storyIdx: number; mediaUri: string | null }
interface Transition { outgoing: Face; direction: 1 | -1 }

interface StoryFaceProps {
  group: StoryGroup<ViewerEntry>;
  storyIdx: number;
  mediaUri: string | null;
  mediaLoading: boolean;
  /** The playing segment's progress, or null to draw it finished (a face that is turning away). */
  progress: Animated.Value | null;
  paused: boolean;
  onVideoEnd?: () => void;
  onClose?: () => void;
  style?: React.ComponentProps<typeof Animated.View>['style'];
}

function StoryFace({
  group, storyIdx, mediaUri, mediaLoading, progress, paused, onVideoEnd, onClose, style,
}: StoryFaceProps) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const story = group.stories[storyIdx];
  const isVideo = story.data.mediaType === 'video';
  const text = story.data.content || story.data.caption || '';
  const meta = parseCaptionMeta(story.data.captionMeta);

  return (
    <Animated.View style={[styles.face, style]}>
      {mediaUri && (isVideo ? (
        <Video
          source={{ uri: mediaUri, type: 'mp4' }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          paused={paused}
          onEnd={onVideoEnd}
          onError={(e) => logError('storyVideo', e)}
        />
      ) : (
        <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ))}

      {/* Progress bars — only the currently-playing segment is Animated. */}
      <View style={[styles.progressRow, { paddingTop: insets.top + 8 }]}>
        {group.stories.map((_, i) => (
          <View key={i} style={styles.progressTrack}>
            {i < storyIdx || (i === storyIdx && progress === null) ? (
              <View style={[styles.progressFill, styles.progressFillFull]} />
            ) : i === storyIdx && progress !== null ? (
              <Animated.View style={[
                styles.progressFill,
                { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
              ]} />
            ) : null}
          </View>
        ))}
      </View>

      <View style={styles.header}>
        <Avatar name={group.username} size={32} background={colors.surfaceMuted} color={colors.text} />
        <Text style={styles.headerName}>{group.username}</Text>
        <Text style={styles.headerTime}>{timeAgo(story.sentAt)}</Text>
        <TouchableOpacity onPress={onClose} disabled={!onClose} style={styles.closeBtn}>
          <CloseIcon size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.content}>
        {mediaLoading && <ActivityIndicator color={colors.text} size="large" />}
        {!mediaUri && text !== '' && <Text style={styles.contentText}>{text}</Text>}
        {!mediaLoading && !mediaUri && text === '' && attachmentOf(story) !== null && (
          <Text style={styles.unavailableText}>Media unavailable</Text>
        )}
      </View>

      {mediaUri && text !== '' ? (
        meta
          ? <CaptionView meta={meta} text={text} width={W} height={H} />
          : <Text style={[styles.captionOverlay, { bottom: insets.bottom + 48 }]}>{text}</Text>
      ) : null}
    </Animated.View>
  );
}

/** Full-screen viewer for live stories (`mode: 'stories'`) and view-once pix (`mode: 'pix'`). */
export function StoryViewerScreen({ route, navigation }: RootStackScreenProps<'StoryViewer'>) {
  const params = route.params;
  const markViewed = params.mode === 'pix';
  const identity = useIdentity();
  const allStories = useModelEntries('story');
  const allPix = useModelEntries('pix');
  const [openedAt] = useState(() => Date.now());

  const { groups, initialGroupIdx } = useMemo((): { groups: StoryGroup<ViewerEntry>[]; initialGroupIdx: number } => {
    if (params.mode === 'pix') {
      const wanted = new Set(params.entryIds);
      const stories = allPix
        .filter((p) => wanted.has(p.id))
        .sort((a, b) => a.sentAt - b.sentAt);
      const username = identity.friends.find((f) => f.userId === params.userId)?.username ?? params.username;
      return {
        groups: stories.length > 0 ? [{ userId: params.userId, username, stories }] : [],
        initialGroupIdx: 0,
      };
    }
    const { mine, others } = storyGroups(allStories, identity, openedAt);
    const populated = [mine, ...others].filter((g) => g.stories.length > 0);
    const idx = populated.findIndex((g) => g.userId === params.initialUserId);
    return { groups: populated, initialGroupIdx: Math.max(0, idx) };
  }, [params, allStories, allPix, identity, openedAt]);

  const [groupIdx, setGroupIdx] = useState(initialGroupIdx);
  const [storyIdx, setStoryIdx] = useState(0);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [transition, setTransition] = useState<Transition | null>(null);
  const { width: W } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const cube = useRef(new Animated.Value(0)).current;
  const mediaUris = useRef(new Map<string, string>()).current;

  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];

  useEffect(() => {
    if (!group || !story) navigation.goBack();
  }, [group, story, navigation]);

  const viewedIds = useRef(new Set<string>());
  const markCurrentViewed = useCallback(() => {
    if (!story || !markViewed || viewedIds.current.has(story.id)) return;
    viewedIds.current.add(story.id);
    markSeen('pix', story).catch((e) => logError('seen.pix:' + story.id, e));
  }, [markViewed, story]);

  useEffect(() => navigation.addListener('beforeRemove', markCurrentViewed), [navigation, markCurrentViewed]);

  const turnTo = useCallback((nextGroupIdx: number, direction: 1 | -1) => {
    if (!group) return;
    setTransition({ outgoing: { group, storyIdx, mediaUri }, direction });
    setGroupIdx(nextGroupIdx);
    setStoryIdx(0);
    cube.setValue(0);
    Animated.timing(cube, {
      toValue: 1, duration: CUBE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start(() => setTransition(null));
  }, [group, storyIdx, mediaUri, cube]);

  const groupLengths = useMemo(() => groups.map((g) => g.stories.length), [groups]);

  const applyStep = useCallback((action: 'advance' | 'rewind') => {
    if (!group || transition) return;
    if (action === 'advance') markCurrentViewed();
    const step = stepViewer({ groupIdx, storyIdx }, groupLengths, action, markViewed);
    switch (step.kind) {
      case 'stay':
        return;
      case 'step':
        setGroupIdx(step.cursor.groupIdx);
        setStoryIdx(step.cursor.storyIdx);
        return;
      case 'turnCube':
        turnTo(step.cursor.groupIdx, step.direction);
        return;
      case 'close':
        navigation.goBack();
        return;
    }
  }, [group, transition, markCurrentViewed, groupIdx, storyIdx, groupLengths, markViewed, turnTo, navigation]);

  const advance = useCallback(() => applyStep('advance'), [applyStep]);
  const rewind = useCallback(() => applyStep('rewind'), [applyStep]);

  const mediaRef = story?.data.mediaRef;
  const contentKey = story?.data.contentKey;
  const nonce = story?.data.nonce;
  const attachment = useMemo<Attachment | null>(
    () => (mediaRef && contentKey && nonce ? { mediaRef, contentKey, nonce } : null),
    [mediaRef, contentKey, nonce],
  );

  useEffect(() => {
    setMediaLoading(false);
    if (!attachment) { setMediaUri(null); return; }
    const cached = mediaUris.get(attachment.mediaRef);
    if (cached) { setMediaUri(cached); return; }
    setMediaUri(null);
    let cancelled = false;
    (async () => {
      try {
        setMediaLoading(true);
        const uri = await loadAttachmentUri(attachment, mediaUris);
        if (!cancelled) setMediaUri(uri);
      } catch (e) {
        logError('storyMedia.load', e);
      } finally {
        if (!cancelled) setMediaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment, mediaUris]);

  useEffect(() => {
    for (const neighbour of [groups[groupIdx + 1], groups[groupIdx - 1]]) {
      const att = attachmentOf(neighbour?.stories[0]);
      if (att && !mediaUris.has(att.mediaRef)) {
        loadAttachmentUri(att, mediaUris).catch((e) => logError('storyMedia.prefetch', e));
      }
    }
  }, [groups, groupIdx, mediaUris]);

  const hasMedia = !!story?.data.mediaRef;
  const isVideo = story?.data.mediaType === 'video';
  const durationMs = displayMs(story?.data.displayDuration);
  const readyToPlay = (!hasMedia || (!!mediaUri && !mediaLoading)) && !transition;

  useEffect(() => {
    progress.setValue(0);
    if (!readyToPlay) return;
    if (isVideo) {
      const anim = Animated.timing(progress, {
        toValue: 1, duration: 15000, easing: Easing.linear, useNativeDriver: false,
      });
      anim.start();
      return () => anim.stop();
    }
    const anim = Animated.timing(progress, {
      toValue: 1, duration: durationMs, easing: Easing.linear, useNativeDriver: false,
    });
    anim.start(({ finished }) => { if (finished) advance(); });
    return () => anim.stop();
  }, [groupIdx, storyIdx, readyToPlay, isVideo, durationMs, advance, progress]);

  if (!group || !story) return <View style={styles.container} />;

  const incomingTransform = transition ? {
    transform: cubeFace(W, cube.interpolate({
      inputRange: [0, 1],
      outputRange: [transition.direction === 1 ? '90deg' : '-90deg', '0deg'],
    })),
  } : undefined;
  const outgoingTransform = transition ? {
    transform: cubeFace(W, cube.interpolate({
      inputRange: [0, 1],
      outputRange: ['0deg', transition.direction === 1 ? '-90deg' : '90deg'],
    })),
  } : undefined;

  return (
    <View style={styles.container}>
      {transition && (
        <StoryFace
          group={transition.outgoing.group}
          storyIdx={transition.outgoing.storyIdx}
          mediaUri={transition.outgoing.mediaUri}
          mediaLoading={false}
          progress={null}
          paused={true}
          style={outgoingTransform}
        />
      )}
      <StoryFace
        group={group}
        storyIdx={storyIdx}
        mediaUri={mediaUri}
        mediaLoading={mediaLoading}
        progress={progress}
        paused={!readyToPlay}
        onVideoEnd={advance}
        onClose={() => navigation.goBack()}
        style={incomingTransform}
      />

      <View style={styles.tapZones}>
        <TouchableOpacity style={styles.tapLeft} onPress={rewind} activeOpacity={1} />
        <TouchableOpacity style={styles.tapRight} onPress={advance} activeOpacity={1} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', overflow: 'hidden' },
  face: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#000' },
  progressRow: { flexDirection: 'row', paddingHorizontal: 8, gap: 4 },
  progressTrack: { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 1 },
  progressFillFull: { width: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 },
  headerName: { color: '#fff', fontWeight: '600', fontSize: 15, flex: 1 },
  headerTime: { color: colors.textSecondary, fontSize: 13 },
  closeBtn: { padding: 8 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  contentText: { color: '#fff', fontSize: 24, fontWeight: '600', textAlign: 'center' },
  unavailableText: { color: colors.textSecondary, fontSize: 16, textAlign: 'center' },
  captionOverlay: {
    color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 12, position: 'absolute', left: 16, right: 16,
  },
  tapZones: { ...StyleSheet.absoluteFill, flexDirection: 'row', top: 100 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 2 },
});
