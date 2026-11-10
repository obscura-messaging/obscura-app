import { useMemo } from 'react';
import { DevSettings } from 'react-native';
import { create } from 'zustand';
import type { ConversationItem, DirectMessageItem } from '../domain/chats';
import type { Friend, Identity } from '../domain/friends';
import type { StoryItem } from '../domain/viewer';
import { useAcceptedFriends, useIdentity, useMessages, useSession, useStories } from '../state/store';
import { useUi2 } from './store';
import { sampleData, type SampleFace, type SampleSize } from './sample';

// claude: what the ui2 chat screens read, from the real store or, in dev, from sample.ts.
export interface ChatsData {
  sample: boolean;
  myUserId: string;
  identity: Identity;
  friends: Friend[];
  items: ConversationItem[];
  stories: StoryItem[];
  typingUserId: string | null;
  faces: Readonly<Record<string, SampleFace>>;
}

const NO_FACES: Readonly<Record<string, SampleFace>> = {};

// claude: messages sent in sample chats, kept in memory and cleared when the sample changes.
const useSampleSent = create<{ sent: DirectMessageItem[] }>(() => ({ sent: [] }));

export function sendSampleMessage(peerUserId: string, myUserId: string, content: string) {
  const { sent } = useSampleSent.getState();
  const sentAt = Date.now();
  useSampleSent.setState({
    sent: [...sent, { kind: 'message', id: `${peerUserId}-sent${sent.length}`, peerUserId, authorUserId: myUserId, sentAt, viewedAt: sentAt, content }],
  });
}

function setSample(sample: SampleSize | null) {
  useSampleSent.setState({ sent: [] });
  useUi2.setState({ sample });
}

if (__DEV__) {
  DevSettings.addMenuItem('Sample data: off', () => setSample(null));
  DevSettings.addMenuItem('Sample data: 0 chats', () => setSample(0));
  DevSettings.addMenuItem('Sample data: 2 chats', () => setSample(2));
  DevSettings.addMenuItem('Sample data: 20 chats', () => setSample(20));
}

export function useChatsData(): ChatsData {
  const { myUserId } = useSession();
  const identity = useIdentity();
  const friends = useAcceptedFriends();
  const items = useMessages();
  const stories = useStories();
  const size = useUi2(s => s.sample);
  const sent = useSampleSent(s => s.sent);
  const sample = useMemo(() => (size === null ? null : sampleData(size, myUserId)), [size, myUserId]);
  return useMemo(() => (sample === null
    ? { sample: false, myUserId, identity, friends, items, stories, typingUserId: null, faces: NO_FACES }
    : {
      sample: true, myUserId, identity: { ...identity, friends: sample.friends }, friends: sample.friends,
      items: [...sample.items, ...sent], stories: sample.stories, typingUserId: sample.typingUserId, faces: sample.faces,
    }), [sample, sent, myUserId, identity, friends, items, stories]);
}
