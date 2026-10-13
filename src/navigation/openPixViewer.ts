import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Friend } from '../native/ObscuraModule';
import type { RootStackParamList, ViewerEntry } from './types';

/** Show a sender's view-once pix in the story viewer, oldest first. */
export function openPixViewer(
  nav: NativeStackNavigationProp<RootStackParamList>,
  sender: Friend,
  entries: readonly ViewerEntry[],
): void {
  if (entries.length === 0) return;
  const stories = [...entries].sort((a, b) => a.sentAt - b.sentAt);
  nav.navigate('StoryViewer', {
    groups: [{ userId: sender.userId, username: sender.username, stories }],
    startIndex: 0,
    markViewed: true,
  });
}
