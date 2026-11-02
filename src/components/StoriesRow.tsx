import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Avatar } from './Avatar';
import { storyGroups } from '../domain/stories';
import { useIdentity, useModelEntries } from '../state/store';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

function StoryCircle({ label, username, empty, onPress }: {
  label: string; username: string; empty: boolean; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.circle} onPress={onPress}>
      <View style={styles.ringWrap}>
        <View style={[styles.ring, empty && styles.ringEmpty]}>
          <Avatar name={username} size={54} background={colors.surface} color={colors.text} />
        </View>
        {empty && (
          <View style={styles.addBadge}>
            <Text style={styles.addBadgeText}>+</Text>
          </View>
        )}
      </View>
      <Text style={styles.username} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

/** The horizontal strip of 24h story circles at the top of the chat list. */
export function StoriesRow() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const identity = useIdentity();
  const stories = useModelEntries('story');
  // Stories past their age are hidden until the sweep erases them.
  const { mine, others } = useMemo(() => storyGroups(stories, identity, Date.now()), [stories, identity]);

  const open = (userId: string) => {
    nav.navigate('StoryViewer', { mode: 'stories', initialUserId: userId });
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.row}
      contentContainerStyle={styles.rowContent}
    >
      <StoryCircle
        label="My story"
        username={mine.username}
        empty={mine.stories.length === 0}
        onPress={() => (mine.stories.length === 0 ? nav.navigate('MainTabs', { screen: 'Camera' }) : open(mine.userId))}
      />
      {others.map((g) => (
        <StoryCircle key={g.userId} label={g.username} username={g.username} empty={false} onPress={() => open(g.userId)} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexGrow: 0, paddingTop: 8, paddingBottom: 8 },
  rowContent: { paddingHorizontal: 16 },
  circle: { alignItems: 'center', marginRight: 16, width: 72 },
  ringWrap: { width: 64, height: 64 },
  ring: {
    width: 64, height: 64, borderRadius: 32, borderWidth: 3,
    borderColor: colors.accent, justifyContent: 'center', alignItems: 'center',
  },
  ringEmpty: { borderColor: colors.surfaceMuted, borderStyle: 'dashed' },
  addBadge: {
    position: 'absolute', right: 0, bottom: 0, width: 20, height: 20,
    borderRadius: 10, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center',
  },
  addBadgeText: { color: colors.onAccent, fontWeight: '700', fontSize: 14, marginTop: -1 },
  username: { color: '#ccc', fontSize: 11, marginTop: 4, textAlign: 'center' },
});
