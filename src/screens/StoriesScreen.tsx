import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, Image, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Video from 'react-native-video';
import { CaptionView, parseCaptionMeta } from '../components/Caption';
import { CloseIcon } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { timeAgo as fmtTimeAgo } from '../utils/format';
import { useSession, useModelEntries, markSeen, type ScreenEntry } from '../state/store';
import { storyExpiresAt } from '../domain/expiry';
import { displayNameFor } from '../domain/friends';
import type { RootStackParamList, RootStackScreenProps, StoryGroup } from '../navigation/types';
import { colors } from '../styles';

const STORY_DURATION = 5000; // 5 seconds per story

// ─── Story Circle (avatar with ring) ──────────────────────

function StoryCircle({ group, onPress }: { group: StoryGroup; onPress: () => void }) {
  return (
    <TouchableOpacity style={sc.container} onPress={onPress}>
      <View style={[sc.ring, group.isMe && group.stories.length === 0 && sc.ringEmpty]}>
        <Avatar name={group.username} size={54} background={colors.surface} color={colors.text} />
      </View>
      {group.isMe && group.stories.length === 0 && (
        <View style={sc.addBadge}><Text style={sc.addBadgeText}>+</Text></View>
      )}
      <Text style={sc.username} numberOfLines={1}>
        {group.isMe ? 'My story' : group.username}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Story Viewer (full-screen, route-driven) ─────────────

export function StoryViewer({ route, navigation }: RootStackScreenProps<'StoryViewer'>) {
  const { groups, startIndex, markViewed } = route.params;
  const [groupIdx, setGroupIdx] = useState(startIndex);
  const [storyIdx, setStoryIdx] = useState(0);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];

  // One receipt per pix, however the viewer is left.
  const viewedIdsRef = useRef<Set<string>>(new Set());

  const markCurrentViewed = useCallback(() => {
    if (!markViewed || !story) return;
    if (viewedIdsRef.current.has(story.id)) return;
    viewedIdsRef.current.add(story.id);
    markSeen('pix', story).catch((e) => logError('seen.pix:' + story.id, e));
  }, [markViewed, story]);

  // Every exit path (header back, hardware back, iOS swipe-back, close button) sends the receipt.
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', markCurrentViewed);
    return sub;
  }, [navigation, markCurrentViewed]);

  const close = useCallback(() => {
    markCurrentViewed();
    navigation.goBack();
  }, [markCurrentViewed, navigation]);

  const advance = useCallback(() => {
    if (!group) { navigation.goBack(); return; }
    markCurrentViewed();
    if (storyIdx < group.stories.length - 1) {
      setStoryIdx(i => i + 1);
    } else if (groupIdx < groups.length - 1) {
      setGroupIdx(i => i + 1);
      setStoryIdx(0);
    } else {
      navigation.goBack();
    }
  }, [group, groupIdx, storyIdx, groups.length, markCurrentViewed, navigation]);

  const goBack = useCallback(() => {
    // View-once pix (markViewed) must not be re-viewable: once a pix is shown
    // and its receipt fired, tapping back to it would defeat view-once. Only
    // stories allow rewinding within the session.
    if (markViewed) return;
    if (storyIdx > 0) {
      setStoryIdx(i => i - 1);
    } else if (groupIdx > 0) {
      setGroupIdx(i => i - 1);
      setStoryIdx(0);
    }
  }, [storyIdx, groupIdx, markViewed]);

  // Resolve the attachment ref into a stable object so the load effect's
  // dep array is honest. Without this, the effect either drops deps and
  // gets a stale closure warning, or includes them and re-fires whenever
  // React re-renders for any reason (sets up new fetches on every paint).
  const attachment = useMemo(() => {
    const mediaRef = story?.data.mediaRef as string | undefined;
    const contentKey = story?.data.contentKey as string | undefined;
    const nonce = story?.data.nonce as string | undefined;
    if (!mediaRef || !contentKey || !nonce) return null;
    return { mediaRef, contentKey, nonce };
  }, [story?.data.mediaRef, story?.data.contentKey, story?.data.nonce]);

  // Load media if the entry has an attachment — native decrypts to a cached
  // file and returns the path, which we use as a `file://` URI. No base64
  // payload in JS, no `data:` URI in Image. Story and pix share the shape.
  useEffect(() => {
    setMediaUri(null);
    if (!attachment) return;
    let cancelled = false;
    (async () => {
      try {
        setMediaLoading(true);
        const path = await Obscura.downloadAttachment(attachment.mediaRef, attachment.contentKey, attachment.nonce);
        if (!cancelled) setMediaUri(`file://${path}`);
      } catch (e) {
        logError('storyMedia.load', e);
      } finally {
        if (!cancelled) setMediaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment]);

  // Auto-advance timer — waits for media to load before starting.
  // (Declared AFTER mediaLoading/mediaUri so the closure sees real state.)
  const hasMedia = !!story?.data.mediaRef;
  const readyToPlay = !hasMedia || !mediaLoading;

  // Keep advance current in a ref so the timer effect doesn't re-fire every
  // time advance's identity changes (which is every story transition — would
  // double-schedule the timer).
  const advanceRef = useRef(advance);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  const displayDurationMs = story?.data.displayDuration
    ? Number(story.data.displayDuration) * 1000
    : STORY_DURATION;
  const isVideo = story?.data.mediaType === 'video';

  useEffect(() => {
    if (!readyToPlay) { progress.setValue(0); return; }
    // Video drives its own advance via onEnd (plays to its natural length),
    // so skip the fixed photo timer for it.
    if (isVideo) { progress.setValue(0); return; }
    const dur = displayDurationMs > 0 ? displayDurationMs : STORY_DURATION;
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1, duration: dur, useNativeDriver: false,
    });
    anim.start();
    timerRef.current = setTimeout(() => advanceRef.current(), dur);
    return () => {
      anim.stop();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [groupIdx, storyIdx, readyToPlay, displayDurationMs, progress, isVideo]);

  if (!story) { navigation.goBack(); return null; }

  const timeAgo = fmtTimeAgo(story.sentAt);

  return (
    <View style={sv.container}>
      {/* Background media (if any) */}
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

      {/* Progress bars — only the currently-playing segment is Animated.
          Past/future segments are plain Views with explicit widths because
          React Native won't reset a previously-applied animated `width`
          when you switch to a style object that omits the property. */}
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

      {/* Header */}
      <View style={sv.header}>
        <Avatar name={group.username} size={32} background={colors.surfaceMuted} color={colors.text} />
        <Text style={sv.headerName}>{group.username}</Text>
        <Text style={sv.headerTime}>{timeAgo}</Text>
        <TouchableOpacity onPress={close} style={sv.closeBtn}>
          <CloseIcon size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Text-only content (no media) — centered */}
      <View style={sv.content}>
        {mediaLoading && <ActivityIndicator color="#fff" size="large" />}
        {(() => {
          const text = story.data.content || story.data.caption || '';
          if (!text || mediaUri) return null; // captions over media handled below
          return <Text style={sv.contentText}>{text}</Text>;
        })()}
      </View>

      {/* Styled caption over media; entries without metadata use a plain bottom overlay. */}
      {mediaUri && (() => {
        const text = story.data.content || story.data.caption || '';
        if (!text) return null;
        const meta = parseCaptionMeta(story.data.captionMeta);
        if (meta) return <CaptionView meta={meta} text={text} width={W} height={H} />;
        return <Text style={sv.captionOverlay}>{text}</Text>;
      })()}

      {/* Tap zones: left = back, right = next */}
      <View style={sv.tapZones}>
        <TouchableOpacity style={sv.tapLeft} onPress={goBack} activeOpacity={1} />
        <TouchableOpacity style={sv.tapRight} onPress={advance} activeOpacity={1} />
      </View>
    </View>
  );
}

// ─── Stories Row (horizontal scroll, embedded in ChatList) ────────

export function StoriesRow() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId, myUsername, friends } = useSession();
  const stories = useModelEntries('story');

  // Group stories by their AUTHENTICATED author, me first. Within each group, oldest first so
  // the viewer plays the day's stories in chronological order (Snapchat
  // convention). Across groups, "me" is pinned to position 0; the rest are
  // sorted by their most recent story so freshly-posting friends bubble up.
  //
  // Group by the authenticated author userId, never a payload name. A story whose author is not in
  // the friend graph is dropped rather than shown as "unknown".
  //
  // The sweep erases expired stories within 30 s; until it does, they are hidden here so a story
  // never outlives its day on screen.
  const groups: StoryGroup[] = useMemo(() => {
    const identity = { myUserId, myUsername, friends };
    const now = Date.now();
    const map = new Map<string, ScreenEntry[]>();
    for (const s of stories) {
      if (storyExpiresAt(s.sentAt) <= now) continue;
      const author = s.authorUserId;
      if (displayNameFor(author, identity) === null) continue;
      if (!map.has(author)) map.set(author, []);
      map.get(author)!.push(s);
    }
    for (const entries of map.values()) {
      entries.sort((a, b) => a.sentAt - b.sentAt); // oldest first within a group
    }
    const result: StoryGroup[] = [];
    result.push({ userId: myUserId, username: myUsername, stories: map.get(myUserId) || [], isMe: true });
    map.delete(myUserId);
    const friendGroups = Array.from(map.entries()).map(([userId, entries]) => ({
      userId,
      username: displayNameFor(userId, identity) ?? '',
      stories: entries,
      isMe: false,
    }));
    // Sort friend groups by their newest story (latest activity bubbles up)
    friendGroups.sort((a, b) => {
      const aLatest = a.stories[a.stories.length - 1]?.sentAt ?? 0;
      const bLatest = b.stories[b.stories.length - 1]?.sentAt ?? 0;
      return bLatest - aLatest;
    });
    result.push(...friendGroups);
    return result;
  }, [stories, myUserId, myUsername, friends]);

  const openViewer = (idx: number) => {
    const group = groups[idx];
    if (group.isMe && group.stories.length === 0) {
      // No story yet — take the user to the camera to post one (select
      // "my story" as the recipient after capturing) instead of nagging.
      nav.navigate('MainTabs', { screen: 'Camera' });
      return;
    }
    if (group.stories.length === 0) return;
    // Translate the index into the populated-only viewer list. `idx` is the
    // tapped circle's position in the original `groups` array (which always
    // has "me" at index 0, even when empty), so a naive Math.min(idx, ...)
    // off-by-ones the start when "me" is empty and ≥2 friends have stories.
    const populated = groups.filter(g => g.stories.length > 0);
    const startIndex = populated.indexOf(group);
    nav.navigate('StoryViewer', { groups: populated, startIndex });
  };

  return (
    <View style={ss.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={ss.circleRow}
        contentContainerStyle={ss.circleRowContent}>
        {groups.map((g, i) => (
          <StoryCircle key={g.userId} group={g} onPress={() => openViewer(i)} />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────

const sc = StyleSheet.create({
  container: { alignItems: 'center', marginRight: 16, width: 72 },
  ring: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  ringEmpty: { borderColor: colors.surfaceMuted, borderStyle: 'dashed' },
  addBadge: { position: 'absolute', right: 2, bottom: 14, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  addBadgeText: { color: '#000', fontWeight: '700', fontSize: 14, marginTop: -1 },
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
  container: {},
  circleRow: { paddingTop: 8, paddingBottom: 8 },
  circleRowContent: { paddingHorizontal: 16 },
});
