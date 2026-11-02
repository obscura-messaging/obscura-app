import { NativeEventEmitter, TurboModuleRegistry, type TurboModule } from 'react-native';
import type { ConversationItem } from '../domain/chats';
import type { DeviceInfo } from '../domain/devices';
import type { Friend, ProfileItem } from '../domain/friends';
import type { StoryItem } from '../domain/viewer';

export type { ConversationItem, DeviceInfo, Friend, ProfileItem, StoryItem };

export interface ResizedImage {
  path: string;
  width: number;
  height: number;
}

export interface AttachmentRef {
  id: string;
  contentKey: string;
  nonce: string;
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

  getMessages(): Promise<ConversationItem[]>;
  sendMessage(peerUserId: string, content: string): Promise<string>;
  sendPix(
    peerUserId: string, mediaRef: string, contentKey: string, nonce: string,
    mediaType: string, caption: string, captionMeta: string | null, displayDuration: number,
  ): Promise<string>;
  markSeen(entryId: string): Promise<void>;
  getStories(): Promise<StoryItem[]>;
  postStory(
    content: string, mediaRef: string | null, contentKey: string | null,
    nonce: string | null, mediaType: string | null, captionMeta: string | null,
  ): Promise<string>;
  getProfiles(): Promise<ProfileItem[]>;
  updateProfile(displayName: string, bio: string): Promise<void>;
  flushOutbox(): Promise<number>;
  sweepExpired(): Promise<string[]>;

  sendTyping(peerUserId: string): Promise<void>;
  stopTyping(peerUserId: string): Promise<void>;
  observeTyping(peerUserId: string): Promise<void>;
  stopObservingTyping(peerUserId: string): Promise<void>;

  uploadAttachment(filePath: string): Promise<AttachmentRef>;
  /** Decrypts to a cache file and resolves its absolute path. */
  downloadAttachment(id: string, contentKey: string, nonce: string): Promise<string>;
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

export const Obscura = TurboModuleRegistry.getEnforcing<ObscuraBridge>('ObscuraBridge');

/** The payloads of the native `ObscuraEvent` stream; must match each bridge's `BridgeEvent` enum. */
export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsChanged' }
  | { type: 'messageReceived'; model: string }
  | { type: 'typingChanged'; peerUserId: string; typing: boolean }
  | { type: 'pushTokenReceived'; token: string };

const emitter = new NativeEventEmitter(Obscura);

/** Subscribe to Obscura events. Returns an unsubscribe function. */
export function onObscuraEvent(handler: (event: ObscuraEvent) => void): () => void {
  const sub = emitter.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}
