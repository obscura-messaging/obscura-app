import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, Image, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { CaptionView, parseCaptionMeta } from '../components/Caption';
import { CloseIcon } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { Obscura } from '../native/ObscuraModule';
import { displayMs } from '../domain/pix';
import { storyGroups } from '../domain/stories';
import { useIdentity, useModelEntries, markSeen } from '../state/store';
import { fileUri } from '../utils/files';
import { timeAgo } from '../utils/format';
import { logError } from '../utils/log';
import type { RootStackParamList, RootStackScreenProps } from '../navigation/types';
import { colors } from '../styles';

function StoryCircle({ label, username, empty, onPress }: {
  label: string; username: string; empty: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={sc.container} onPress={onPress}>
      <View style={[sc.ring, empty && sc.ringEmpty]}>
        <Avatar name={username} size={54} background={colors.surface} color={colors.text} />
      </View>
      {empty && <View style={sc.addBadge}><Text style={sc.addBadgeText}>+</Text></View>}
      <Text style={sc.username} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Full-screen viewer for stories and, with `markViewed`, view-once pix. */
export function StoryViewer({ route, navigation }: RootStackScreenProps<'StoryViewer'>) {
  const { groups, startIndex, markViewed } = route.params;
  const [groupIdx, setGroupIdx] = useState(startIndex);
  const [storyIdx, setStoryIdx] = useState(0);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;

  const group = groups[groupIdx];
  const story = group.stories[storyIdx];

  const viewedIds = useRef(new Set<string>());
  const markCurrentViewed = useCallback(() => {
    if (!markViewed || viewedIds.current.has(story.id)) return;
    viewedIds.current.add(story.id);
    markSeen('pix', story).catch((e) => logError('seen.pix:' + story.id, e));
  }, [markViewed, story]);

  // Every way out of the screen sends the receipt.
  useEffect(() => navigation.addListener('beforeRemove', markCurrentViewed), [navigation, markCurrentViewed]);

  const advance = useCallback(() => {
    markCurrentViewed();
    if (storyIdx < group.stories.length - 1) {
      setStoryIdx((i) => i + 1);
    } else if (groupIdx < groups.length - 1) {
      setGroupIdx((i) => i + 1);
      setStoryIdx(0);
    } else {
      navigation.goBack();
    }
  }, [group, groupIdx, storyIdx, groups.length, markCurrentViewed, navigation]);

  const rewind = () => {
    // A view-once pix must not be shown again.
    if (markViewed) return;
    if (storyIdx > 0) {
      setStoryIdx((i) => i - 1);
    } else if (groupIdx > 0) {
      setGroupIdx((i) => i - 1);
      setStoryIdx(0);
    }
  };

  const { mediaRef, contentKey, nonce } = story.data;
  useEffect(() => {
    setMediaUri(null);
    if (!mediaRef || !contentKey || !nonce) return;
    let cancelled = false;
    setMediaLoading(true);
    Obscura.downloadAttachment(mediaRef, contentKey, nonce)
      .then((path) => { if (!cancelled) setMediaUri(fileUri(path)); })
      .catch((e) => logError('storyMedia.load', e))
      .finally(() => { if (!cancelled) setMediaLoading(false); });
    return () => { cancelled = true; };
  }, [mediaRef, contentKey, nonce]);

  // The timer reads the latest `advance` without restarting on every render.
  const advanceRef = useRef(advance);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  const readyToPlay = !mediaRef || !mediaLoading;
  const isVideo = story.data.mediaType === 'video';
  const durationMs = displayMs(story.data.displayDuration);

  useEffect(() => {
    progress.setValue(0);
    // A video advances itself when it ends.
    if (!readyToPlay || isVideo) return;
    const animation = Animated.timing(progress, { toValue: 1, duration: durationMs, useNativeDriver: false });
    animation.start();
    const timer = setTimeout(() => advanceRef.current(), durationMs);
    return () => {
      animation.stop();
      clearTimeout(timer);
    };
  }, [groupIdx, storyIdx, readyToPlay, durationMs, progress, isVideo]);

  const text = story.data.content || story.data.caption || '';
  const captionMeta = parseCaptionMeta(story.data.captionMeta);

  return (
    <View style={sv.container}>
      {mediaUri && (isVideo ? (
        <Video
          source={{ uri: mediaUri, type: 'mp4' }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          paused={!readyToPlay}
          onEnd={() => advanceRef.current()}
          onError={(e) => logError('storyVideo', e)}
        />
      ) : (
        <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ))}

      {/* Only the playing segment is animated: RN does not reset an animated width on a style swap. */}
      <View style={[sv.progressRow, { paddingTop: insets.top + 8 }]}>
        {group.stories.map((_, i) => (
          <View key={i} style={sv.progressTrack}>
            {i < storyIdx ? (
              <View style={[sv.progressFill, sv.progressFillFull]} />
            ) : i === storyIdx ? (
              <Animated.View style={[
                sv.progressFill,
                { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
              ]} />
            ) : null}
          </View>
        ))}
      </View>

      <View style={sv.header}>
        <Avatar name={group.username} size={32} background={colors.surfaceMuted} color={colors.text} />
        <Text style={sv.headerName}>{group.username}</Text>
        <Text style={sv.headerTime}>{timeAgo(story.sentAt)}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={sv.closeBtn}>
          <CloseIcon size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={sv.content}>
        {mediaLoading && <ActivityIndicator color={colors.text} size="large" />}
        {!mediaUri && text !== '' && <Text style={sv.contentText}>{text}</Text>}
      </View>

      {mediaUri && text !== '' && (captionMeta
        ? <CaptionView meta={captionMeta} text={text} width={width} height={height} />
        : <Text style={sv.captionOverlay}>{text}</Text>)}

      <View style={sv.tapZones}>
        <TouchableOpacity style={sv.tapLeft} onPress={rewind} activeOpacity={1} />
        <TouchableOpacity style={sv.tapRight} onPress={advance} activeOpacity={1} />
      </View>
    </View>
  );
}

/** The horizontal row of story circles at the top of the chat list. */
export function StoriesRow() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const identity = useIdentity();
  const stories = useModelEntries('story');
  // Stories past their age are hidden until the sweep erases them.
  const { mine, others } = useMemo(() => storyGroups(stories, identity, Date.now()), [stories, identity]);

  const open = (group: typeof mine) => {
    const populated = [mine, ...others].filter((g) => g.stories.length > 0);
    nav.navigate('StoryViewer', { groups: populated, startIndex: populated.indexOf(group) });
  };

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={ss.circleRow}
      contentContainerStyle={ss.circleRowContent}>
      <StoryCircle
        label="My story"
        username={mine.username}
        empty={mine.stories.length === 0}
        // With nothing posted yet, go and take one.
        onPress={() => (mine.stories.length === 0 ? nav.navigate('MainTabs', { screen: 'Camera' }) : open(mine))}
      />
      {others.map((g) => (
        <StoryCircle key={g.userId} label={g.username} username={g.username} empty={false} onPress={() => open(g)} />
      ))}
    </ScrollView>
  );
}

const sc = StyleSheet.create({
  container: { alignItems: 'center', marginRight: 16, width: 72 },
  ring: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  ringEmpty: { borderColor: colors.surfaceMuted, borderStyle: 'dashed' },
  addBadge: { position: 'absolute', right: 2, bottom: 14, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  addBadgeText: { color: colors.onAccent, fontWeight: '700', fontSize: 14, marginTop: -1 },
  username: { color: '#ccc', fontSize: 11, marginTop: 4, textAlign: 'center' },
});

const sv = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
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
  captionOverlay: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, position: 'absolute', bottom: 80 },
  tapZones: { ...StyleSheet.absoluteFill, flexDirection: 'row', top: 100 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 2 },
});

const ss = StyleSheet.create({
  circleRow: { paddingTop: 8, paddingBottom: 8 },
  circleRowContent: { paddingHorizontal: 16 },
});
