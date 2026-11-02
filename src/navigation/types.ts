import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { ScreenEntry } from '../domain/seen';
import type { ModelData } from '../models/schema';
import type { Capture, MediaType } from '../state/sendMedia';

export type MainTabParamList = {
  Camera: undefined;
  Chats: undefined;
};

/** The story viewer shows stories and pix alike. */
export type ViewerEntry = ScreenEntry<Partial<ModelData<'story'> & ModelData<'pix'>>>;

/** Normalized navigation target for `StoryViewer`: either live stories starting at a user, or specific view-once pix IDs. */
export type StoryViewerParams =
  | { readonly mode: 'stories'; readonly initialUserId: string }
  | { readonly mode: 'pix'; readonly userId: string; readonly username: string; readonly entryIds: readonly string[] };

export type RootStackParamList = {
  /** Shown while the cold-start auth check runs. */
  Splash: undefined;
  Auth: undefined;
  MainTabs: NavigatorScreenParams<MainTabParamList>;
  Chat: { userId: string; username: string };
  PhotoPreview: { path: string; mediaType: MediaType };
  RecipientPicker: Capture;
  StoryViewer: StoryViewerParams;
  Profile: undefined;
  AddFriend: undefined;
  ScanFriend: undefined;
  Devices: undefined;
  ScanLink: undefined;
};

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;
