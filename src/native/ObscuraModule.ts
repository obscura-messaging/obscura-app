import { NativeEventEmitter, TurboModuleRegistry } from 'react-native';

export interface Friend {
  userId: string;
  username: string;
  status: 'pending_sent' | 'pending_received' | 'accepted';
}

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

/** One row of the kit's durable inbox. For an unknown `kind`, `payload` is lossy and never read. */
export interface InboxRow {
  /** Monotonic per install: the drain order, not a message id. */
  id: number;
  /** The payload arm, e.g. `APP_ENTRY`; `UNKNOWN` for an arm the kit does not know. */
  kind: string;
  /** Server-stamped sender. */
  senderUserId: string;
  /** The device whose Signal session decrypted the row: attribution and the merge tie-break. */
  senderDeviceId: string | null;
  /** Null for every kind but `APP_ENTRY`. */
  modelKey: string | null;
  entryId: string | null;
  sentAt: number | null;
  payload: string;
}

export interface StoredEntry {
  id: string;
  data: string;
  sentAt: number;
  authorDeviceId: string;
  localMetadata: string | null;
}

/** `accepted` means queued by the server. A null `deviceId` is a user-level result. */
export interface SubmissionResult {
  userId: string;
  deviceId: string | null;
  status: 'accepted' | 'rejected' | 'unknown';
  error: string | null;
}

export interface SendReport {
  recipients: SubmissionResult[];
  /** The author's own other devices. */
  selfSync: SubmissionResult[];
}

export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export type AuthState = 'loggedOut' | 'authenticated';
export type AppLifecycleState = 'active' | 'background';

export interface LaunchIntent {
  screen: string;
}

export type LoginScenario =
  | 'existingDevice'
  | 'newDevice'
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
  | 'STORAGE_ERROR';

/** The native `ObscuraBridge` module. Behaviour beyond these types is in `docs/BRIDGE.md`. */
export interface ObscuraBridge {
  registerUser(username: string, password: string): Promise<void>;
  login(username: string, password: string): Promise<LoginScenario>;
  loginAndProvision(username: string, password: string): Promise<void>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  wipeDevice(): Promise<void>;

  getConnectionState(): Promise<ConnectionState>;
  getAuthState(): Promise<AuthState>;
  getUserId(): Promise<string | null>;
  getUsername(): Promise<string | null>;
  getDeviceId(): Promise<string | null>;

  acceptFriend(userId: string): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  getFriendCode(): Promise<string>;
  addFriendByCode(code: string): Promise<void>;
  getFriends(): Promise<Friend[]>;

  /** Oldest first, without side effects. */
  inboxPeek(limit: number): Promise<InboxRow[]>;
  inboxConsume(ids: number[]): Promise<void>;
  /** Permanent data loss; the kit logs `reason`. */
  inboxDiscard(ids: number[], reason: string): Promise<void>;
  inboxDepth(): Promise<number>;

  /** A blind upsert. */
  entryPut(
    model: string, id: string, dataJson: string, sentAt: number, authorDeviceId: string,
    localMetadataJson: string | null,
  ): Promise<void>;
  entryGet(model: string, ids: string[]): Promise<StoredEntry[]>;
  entryAll(model: string): Promise<StoredEntry[]>;
  entryErase(model: string, ids: string[]): Promise<void>;
  sendEntry(
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<SendReport>;

  sendTyping(recipientUserIds: string[], conversationId: string): Promise<void>;
  stopTyping(recipientUserIds: string[], conversationId: string): Promise<void>;
  observeTyping(conversationId: string): Promise<void>;
  stopObservingTyping(conversationId: string): Promise<void>;

  uploadAttachment(filePath: string): Promise<AttachmentRef>;
  /** Decrypts to a cache file and resolves its absolute path. */
  downloadAttachment(id: string, contentKey: string, nonce: string): Promise<string>;
  purgeAttachment(id: string): Promise<void>;
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

export const Obscura = TurboModuleRegistry.getEnforcing('ObscuraBridge') as unknown as ObscuraBridge;

/** The payloads of the native `ObscuraEvent` stream; must match each bridge's `BridgeEvent` enum. */
export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsChanged' }
  | { type: 'messageReceived'; model: string }
  | { type: 'typingChanged'; conversationId: string; userIds: string[] }
  | { type: 'pushTokenReceived'; token: string };

const emitter = new NativeEventEmitter(Obscura as never);

/** Subscribe to Obscura events. Returns an unsubscribe function. */
export function onObscuraEvent(handler: (event: ObscuraEvent) => void): () => void {
  const sub = emitter.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}
