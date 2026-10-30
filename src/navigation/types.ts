import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { Friend } from '../native/ObscuraModule';
import type { ScreenEntry } from '../domain/seen';
import type { StoryGroup } from '../domain/stories';
import type { ModelData } from '../models/schema';
import type { Capture, MediaType } from '../state/sendMedia';

export type MainTabParamList = {
  Camera: undefined;
  Chats: undefined;
};

/** The story viewer shows stories and pix alike. */
export type ViewerEntry = ScreenEntry<Partial<ModelData<'story'> & ModelData<'pix'>>>;

export type RootStackParamList = {
  /** Shown while the cold-start auth check runs. */
  Splash: undefined;
  Auth: undefined;
  MainTabs: NavigatorScreenParams<MainTabParamList>;
  Chat: { friend: Friend };
  PhotoPreview: { path: string; mediaType: MediaType };
  RecipientPicker: Capture;
  StoryViewer: {
    groups: StoryGroup<ViewerEntry>[];
    startIndex: number;
    /** View-once pix: send seen receipts and forbid going back. */
    markViewed?: boolean;
  };
  Profile: undefined;
  AddFriend: undefined;
  ScanFriend: undefined;
  Devices: undefined;
  ScanLink: undefined;
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;
