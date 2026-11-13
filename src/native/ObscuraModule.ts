import { NativeEventEmitter, TurboModuleRegistry, type TurboModule } from 'react-native';
import { parseCaptionMeta, type CaptionMeta } from '../domain/caption';
import type { ConversationItem, DirectMessageItem, PixItem } from '../domain/chats';
import type { DeviceInfo } from '../domain/devices';
import type { Friend, ProfileItem } from '../domain/friends';
import type { MediaAttachment, MediaType, StoryItem } from '../domain/viewer';

export type {
  CaptionMeta, ConversationItem, DeviceInfo, DirectMessageItem,
  Friend, MediaAttachment, MediaType, PixItem, ProfileItem, StoryItem,
};

export interface ResizedImage {
  path: string;
  width: number;
  height: number;
}

/** An attachment as the kit describes it. Its key material stays native; download it by entry id. */
export interface RawAttachment {
  id: string;
  mediaType: string;
}

/** One capture, uploaded once and sent to each recipient and optionally the story. */
export interface CaptureRequest {
  path: string;
  mediaType: MediaType;
  caption: string;
  /** Serialized `CaptionMeta`; the kit stores it opaquely. */
  captionMeta: string | null;
  displayDuration: number;
  recipientUserIds: string[];
  toStory: boolean;
}

/** What could not be delivered; the kit stored those entries and retries them from the outbox. */
export interface CaptureResult {
  undeliveredUserIds: string[];
  storyUndelivered: boolean;
}

/** The content models the kit reports as changed, by `messageReceived` and `sweepExpired`. */
export type EntryModel = 'directMessage' | 'pix' | 'seen' | 'story' | 'profile';

export interface RawDirectMessageItem {
  kind: 'message';
  id: string;
  peerUserId: string;
  authorUserId: string;
  sentAt: number;
  viewedAt: number | null;
  content: string;
}

export interface RawPixItem {
  kind: 'pix';
  id: string;
  peerUserId: string;
  authorUserId: string;
  sentAt: number;
  viewedAt: number | null;
  attachment: RawAttachment;
  caption: string | null;
  captionMeta: string | null;
  displayDuration: number;
}

export type RawConversationItem = RawDirectMessageItem | RawPixItem;

export interface RawStoryItem {
  id: string;
  authorUserId: string;
  sentAt: number;
  content: string;
  attachment?: RawAttachment | null;
  captionMeta: string | null;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export type AuthState = 'loggedOut' | 'authenticated';
export type AppLifecycleState = 'active' | 'background';

export interface LaunchIntent {
  screen: string;
}

export type LoginScenario =
  | 'existingDevice'
  | 'linkRequired'
  | 'deviceMismatch'
  | 'invalidCredentials';

/** The `code` of a kit rejection, mirroring `ObscuraError.kt`. Other failures use a per-method code. */
export type ObscuraErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_FRIEND_CODE'
  | 'HTTP_ERROR'
  | 'CONNECTION_FAILED'
  | 'SEND_FAILED'
  | 'PROTOCOL_VIOLATION'
  | 'STORAGE_ERROR'
  | 'NOT_PRIMARY'
  | 'LINK_FAILED';

type EventModule = NonNullable<ConstructorParameters<typeof NativeEventEmitter>[0]>;

/** The native `ObscuraBridge` module. Behaviour beyond these types is in `docs/BRIDGE.md`. */
export interface ObscuraBridge extends TurboModule, EventModule {
  registerUser(username: string, password: string): Promise<void>;
  login(username: string, password: string): Promise<LoginScenario>;
  /** Deletes every device of the account, wipes local data, and provisions this device as the new primary. */
  resetAccount(username: string, password: string): Promise<void>;
  /** Opens a link session for this device and resolves the code to show the primary. */
  beginLink(username: string, password: string): Promise<string>;
  /** Waits for the primary to approve the pending link, then provisions this device and connects. */
  completeLink(): Promise<void>;
  cancelLink(): Promise<void>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  wipeDevice(): Promise<void>;

  getConnectionState(): Promise<ConnectionState>;
  getAuthState(): Promise<AuthState>;
  getUserId(): Promise<string | null>;
  getUsername(): Promise<string | null>;
  getDeviceId(): Promise<string | null>;
  isPrimary(): Promise<boolean>;

  /** The device name in a link code; rejects `INVALID_ARGUMENT` for anything else. */
  linkCodeDeviceName(code: string): Promise<string>;
  /** Primary only. */
  approveLink(code: string): Promise<void>;
  getDevices(): Promise<DeviceInfo[]>;
  unlinkDevice(deviceId: string): Promise<void>;

  acceptFriend(userId: string): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  getFriendCode(): Promise<string>;
  addFriendByCode(code: string): Promise<void>;
  getFriends(): Promise<Friend[]>;

  getMessages(): Promise<RawConversationItem[]>;
  sendMessage(peerUserId: string, content: string): Promise<string>;
  /** Rejects only if the upload fails; per-recipient failures are in the result. */
  sendCapture(capture: CaptureRequest): Promise<CaptureResult>;
  markSeen(entryId: string): Promise<void>;
  getStories(): Promise<RawStoryItem[]>;
  getProfiles(): Promise<ProfileItem[]>;
  updateProfile(displayName: string, bio: string): Promise<void>;
  flushOutbox(): Promise<number>;
  sweepExpired(): Promise<EntryModel[]>;

  sendTyping(peerUserId: string): Promise<void>;
  stopTyping(peerUserId: string): Promise<void>;
  observeTyping(peerUserId: string): Promise<void>;
  stopObservingTyping(peerUserId: string): Promise<void>;

  /** Decrypts the attachment of a pix or story entry to a cache file and resolves its absolute path. */
  downloadAttachment(entryId: string): Promise<string>;
  resizeImage(srcPath: string, maxDim: number, quality: number): Promise<ResizedImage>;
  writeTestImage(width: number, height: number): Promise<ResizedImage>;

  requestPushPermission(): Promise<boolean>;
  registerPushToken(token: string): Promise<void>;

  getDebugLog(): Promise<string[]>;
  prewarmAudioSession(): Promise<void>;
  deleteFile(path: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
  /** The cold-start notification target, once. */
  getLaunchIntent(): Promise<LaunchIntent | null>;
}

/** The bridge with its content reads normalized into domain types. */
export interface ObscuraClient extends Omit<ObscuraBridge, 'getMessages' | 'getStories'> {
  getMessages(): Promise<ConversationItem[]>;
  getStories(): Promise<StoryItem[]>;
}

function normalizeMediaType(mediaType: string | null | undefined): MediaType {
  return mediaType === 'video' ? 'video' : 'photo';
}

function normalizeAttachment(raw: RawAttachment): MediaAttachment {
  return { id: raw.id, mediaType: normalizeMediaType(raw.mediaType) };
}

function toConversationItem(raw: RawConversationItem): ConversationItem {
  if (raw.kind === 'message') {
    return {
      kind: 'message',
      id: raw.id,
      peerUserId: raw.peerUserId,
      authorUserId: raw.authorUserId,
      sentAt: raw.sentAt,
      viewedAt: raw.viewedAt,
      content: raw.content,
    };
  }
  return {
    kind: 'pix',
    id: raw.id,
    peerUserId: raw.peerUserId,
    authorUserId: raw.authorUserId,
    sentAt: raw.sentAt,
    viewedAt: raw.viewedAt,
    attachment: normalizeAttachment(raw.attachment),
    caption: raw.caption,
    captionMeta: parseCaptionMeta(raw.captionMeta),
    displayDuration: raw.displayDuration,
  };
}

function toStoryItem(raw: RawStoryItem): StoryItem {
  return {
    id: raw.id,
    authorUserId: raw.authorUserId,
    sentAt: raw.sentAt,
    content: raw.content,
    attachment: raw.attachment ? normalizeAttachment(raw.attachment) : null,
    captionMeta: parseCaptionMeta(raw.captionMeta),
  };
}

const rawBridge = TurboModuleRegistry.getEnforcing<ObscuraBridge>('ObscuraBridge');

// A Proxy, not a spread or a prototype: the TurboModule is a JSI host object whose methods are not
// enumerable own properties, and they must be called with the module itself as `this`.
export const Obscura: ObscuraClient = new Proxy(rawBridge, {
  get(target, prop, receiver) {
    switch (prop) {
      case 'getMessages':
        return async (): Promise<ConversationItem[]> => (await target.getMessages()).map(toConversationItem);
      case 'getStories':
        return async (): Promise<StoryItem[]> => (await target.getStories()).map(toStoryItem);
      default: {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }
  },
}) as unknown as ObscuraClient;

/** The payloads of the native `ObscuraEvent` stream; must match each bridge's `BridgeEvent` enum. */
export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsChanged' }
  | { type: 'messageReceived'; model: EntryModel }
  | { type: 'typingChanged'; peerUserId: string; typing: boolean }
  | { type: 'pushTokenReceived'; token: string };

const emitter = new NativeEventEmitter<{ ObscuraEvent: [ObscuraEvent] }>(rawBridge);

/** Subscribe to Obscura events. Returns an unsubscribe function. */
export function onObscuraEvent(handler: (event: ObscuraEvent) => void): () => void {
  const sub = emitter.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}
