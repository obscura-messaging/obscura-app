import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../state/store';
import type { RootStackParamList } from '../navigation/types';
import { AddFriendIcon } from './AddFriendIcon';
import { Avatar } from './Avatar';
import { colors } from '../styles';

export const MAIN_HEADER_CONTENT_HEIGHT = 56;

interface MainHeaderOverlayProps {
  camera: boolean;
}

export function MainHeaderOverlay({ camera }: MainHeaderOverlayProps) {
  const { myUsername } = useSession();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={[
        s.host,
        camera ? s.overCamera : s.overContent,
        { height: insets.top + MAIN_HEADER_CONTENT_HEIGHT, paddingTop: insets.top },
      ]}
    >
      <TouchableOpacity
        onPress={() => nav.navigate('Profile')}
        style={s.action}
        accessibilityLabel="Profile"
      >
        <Avatar name={myUsername} size={32} />
      </TouchableOpacity>
      <Text style={s.title} pointerEvents="none">obscura</Text>
      <TouchableOpacity
        onPress={() => nav.navigate('AddFriend')}
        style={s.action}
        accessibilityLabel="Add friend"
      >
        <AddFriendIcon size={24} color={colors.accent} />
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  overCamera: { backgroundColor: 'rgba(0,0,0,0.32)' },
  overContent: { backgroundColor: colors.bg },
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  action: {
    width: 72,
    height: MAIN_HEADER_CONTENT_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
});
