import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, ViewerEntry } from './types';

/** Show a sender's view-once pix in the story viewer, oldest first, passing only normalized IDs. */
export function openPixViewer(
  nav: NativeStackNavigationProp<RootStackParamList>,
  sender: { userId: string; username: string },
  entries: readonly ViewerEntry[],
): void {
  if (entries.length === 0) return;
  const entryIds = [...entries].sort((a, b) => a.sentAt - b.sentAt).map((e) => e.id);
  nav.navigate('StoryViewer', {
    mode: 'pix',
    userId: sender.userId,
    username: sender.username,
    entryIds,
  });
}
