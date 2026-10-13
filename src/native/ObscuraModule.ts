import { NativeEventEmitter, TurboModuleRegistry } from 'react-native';

interface NativeObscuraBridge {
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
  generateLinkCode(): Promise<string>;
  validateAndApproveLink(code: string): Promise<void>;
  inboxPeek(limit: number): Promise<InboxRow[]>;
  inboxConsume(ids: number[]): Promise<void>;
  inboxDiscard(ids: number[], reason: string): Promise<void>;
  inboxDepth(): Promise<number>;
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
  getLaunchIntent(): Promise<LaunchIntent | null>;
}

// Also resolves legacy (non-Turbo) modules through the interop layer.
const Bridge = TurboModuleRegistry.getEnforcing('ObscuraBridge') as unknown as NativeObscuraBridge;
// ─── Types ───────────────────────────────────────────────

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

/**
 * One row from the kit's durable inbox. For an unknown `kind`, `payload` is a lossy string, which is
 * safe because such a row is discarded without being read.
 */
export interface InboxRow {
  /** Monotonic per install. Drain order. Not a message id. */
  id: number;
  /** The payload arm, e.g. `APP_ENTRY`. `UNKNOWN` for an arm the kit does not know. */
  kind: string;
  /** Server-stamped sender. */
  senderUserId: string;
  /** The device whose Signal session decrypted this — cryptographic attribution, and the merge tie-break. */
  senderDeviceId: string | null;
  /** `AppEntry`-derived, so null for every other kind. */
  modelKey: string | null;
  entryId: string | null;
  sentAt: number | null;
  payload: string;
}

/** One stored entry. `data` is the app's JSON, stored verbatim. */
export interface StoredEntry {
  id: string;
  data: string;
  sentAt: number;
  authorDeviceId: string;
  localMetadata: string | null;
}

/**
 * One device's submission outcome. `accepted` means queued by the server, not delivered or seen. A
 * null `deviceId` is a user-level result (for example, the user has no devices).
 */
export interface SubmissionResult {
  userId: string;
  deviceId: string | null;
  status: 'accepted' | 'rejected' | 'unknown';
  error: string | null;
}

/** A send's per-device outcomes; the author's own other devices are reported apart. */
export interface SendReport {
  recipients: SubmissionResult[];
  selfSync: SubmissionResult[];
}

export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export type AuthState = 'loggedOut' | 'authenticated' | 'pendingApproval';
export type AppLifecycleState = 'active' | 'background';

export interface LaunchIntent {
  /** Screen the app should route to (set when launched via notification tap). */
  screen: string;
}

export type LoginScenario =
  | 'existingDevice'
  | 'newDevice'
  | 'deviceMismatch'
  | 'invalidCredentials';

/**
 * Stable error codes a rejected promise may carry in its `code`, mirroring
 * `ObscuraError.kt` in the kit. Kit-level failures use one of these; anything
 * else falls back to a per-method code (e.g. "ENTRY_PUT_ERROR").
 *
 * `DIRECT_ROUTING_UNRESOLVED` is app-owned (`DOMAIN_CONTRACT.md`), raised
 * by `src/domain/audience.ts`, and therefore excluded from native errors.
 */
export type ObscuraErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_PROVISIONED'
  | 'NOT_FRIENDS'
  | 'NO_DEVICES'
  | 'NO_MESSENGER'
  | 'TIMEOUT'
  | 'DEVICE_LINK_FAILED'
  | 'SEND_FAILED';

// ─── Core API ────────────────────────────────────────────

export const Obscura = {
  // Auth
  register: (username: string, password: string): Promise<void> =>
    Bridge.registerUser(username, password),

  login: (username: string, password: string): Promise<LoginScenario> =>
    Bridge.login(username, password),

  loginAndProvision: (username: string, password: string): Promise<void> =>
    Bridge.loginAndProvision(username, password),

  connect: (): Promise<void> => Bridge.connect(),
  logout: (): Promise<void> => Bridge.logout(),
  wipeDevice: (): Promise<void> => Bridge.wipeDevice(),

  // State
  getConnectionState: (): Promise<ConnectionState> => Bridge.getConnectionState(),
  getAuthState: (): Promise<AuthState> => Bridge.getAuthState(),
  getUserId: (): Promise<string | null> => Bridge.getUserId(),
  getUsername: (): Promise<string | null> => Bridge.getUsername(),
  getDeviceId: (): Promise<string | null> => Bridge.getDeviceId(),

  // Friends
  acceptFriend: (userId: string): Promise<void> =>
    Bridge.acceptFriend(userId),

  /** Forget a friend locally: the friendship and their devices. Nothing is sent to them. */
  removeFriend: (userId: string): Promise<void> => Bridge.removeFriend(userId),

  getFriendCode: (): Promise<string> => Bridge.getFriendCode(),
  addFriendByCode: (code: string): Promise<void> => Bridge.addFriendByCode(code),
  getFriends: (): Promise<Friend[]> => Bridge.getFriends(),

  // Device linking
  generateLinkCode: (): Promise<string> => Bridge.generateLinkCode(),
  validateAndApproveLink: (code: string): Promise<void> =>
    Bridge.validateAndApproveLink(code),

  // ─── Kit data surface ────
  //
  // `inbox` is how messages arrive, `entries` is where the app keeps what it made of them, and
  // `sendEntry` is how they leave. Nothing here parses a payload on either side of the bridge.

  /** Rows waiting, oldest first. Side-effect free — peeking twice returns the same rows. */
  inboxPeek: (limit = 50): Promise<InboxRow[]> => Bridge.inboxPeek(limit),

  /** Drop rows the app has durably processed. Idempotent; a subset is fine. */
  inboxConsume: (ids: number[]): Promise<void> => Bridge.inboxConsume(ids),

  /** Drop rows the app can never process. Permanent data loss; the kit logs `reason`. */
  inboxDiscard: (ids: number[], reason: string): Promise<void> =>
    Bridge.inboxDiscard(ids, reason),

  /** How many rows are waiting. Unbounded growth means the app stopped draining. */
  inboxDepth: (): Promise<number> => Bridge.inboxDepth(),

  /** Blind upsert: merge before calling this. */
  entryPut: (
    model: string,
    id: string,
    dataJson: string,
    sentAt: number,
    authorDeviceId: string,
    localMetadataJson: string | null = null,
  ): Promise<void> =>
    Bridge.entryPut(model, id, dataJson, sentAt, authorDeviceId, localMetadataJson),

  /** The named entries that exist. */
  entryGet: (model: string, ids: string[]): Promise<StoredEntry[]> => Bridge.entryGet(model, ids),

  entryAll: (model: string): Promise<StoredEntry[]> => Bridge.entryAll(model),

  /** Securely remove local entries, with one WAL checkpoint per call. Not synced to peers. */
  entryErase: (model: string, ids: string[]): Promise<void> => Bridge.entryErase(model, ids),

  /** The caller names recipients; the kit resolves no audience. */
  sendEntry: (
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<SendReport> =>
    Bridge.sendEntry(recipientUserIds, modelKey, entryId, sentAt, payloadJson),

  // Signals (typing)
  sendTyping: (recipientUserIds: string[], conversationId: string): Promise<void> =>
    Bridge.sendTyping(recipientUserIds, conversationId),

  stopTyping: (recipientUserIds: string[], conversationId: string): Promise<void> =>
    Bridge.stopTyping(recipientUserIds, conversationId),

  observeTyping: (conversationId: string): Promise<void> =>
    Bridge.observeTyping(conversationId),

  stopObservingTyping: (conversationId: string): Promise<void> =>
    Bridge.stopObservingTyping(conversationId),

  // Attachments — path-based. JS never holds the bytes.
  // upload reads from `filePath`, encrypts, uploads. The source file is left
  // alone (callers are responsible for cleaning up their own temp files).
  uploadAttachment: (filePath: string): Promise<AttachmentRef> =>
    Bridge.uploadAttachment(filePath),
  // download decrypts to a deterministic cache file and returns its absolute path.
  // Repeated downloads of the same id short-circuit (cache hit).
  downloadAttachment: (id: string, contentKey: string, nonce: string): Promise<string> =>
    Bridge.downloadAttachment(id, contentKey, nonce),

  /** Delete this device's decrypted copy of an attachment. */
  purgeAttachment: (id: string): Promise<void> => Bridge.purgeAttachment(id),

  // Image processing — keeps bytes native.
  resizeImage: (srcPath: string, maxDim: number, quality: number): Promise<ResizedImage> =>
    Bridge.resizeImage(srcPath, maxDim, quality),
  /** Solid-color JPEG for emulators with no camera. */
  writeTestImage: (width: number, height: number): Promise<ResizedImage> =>
    Bridge.writeTestImage(width, height),

  // Push notifications. Android emits `pushTokenReceived` after a granted
  // permission request and on Firebase token rotation. iOS token forwarding is
  // not wired. Consumers register every token event with the server.
  requestPushPermission: (): Promise<boolean> => Bridge.requestPushPermission(),
  registerPushToken: (token: string): Promise<void> => Bridge.registerPushToken(token),

  // Misc
  getDebugLog: (): Promise<string[]> => Bridge.getDebugLog(),
  /**
   * Warm up the audio HAL so video recording starts instantly. Cold
   * AVAudioSession activation on iOS costs ~1.4s; call this when the camera
   * appears. No-op on Android (fast audio init). Idempotent.
   */
  prewarmAudioSession: (): Promise<void> => Bridge.prewarmAudioSession(),
  /** Best-effort unlink. Used to clean up temp capture files. */
  deleteFile: (path: string): Promise<void> => Bridge.deleteFile(path),
  /** Write `text` to the system clipboard. Replaces RN core's deprecated Clipboard module. */
  setClipboard: (text: string): Promise<void> => Bridge.setClipboard(text),
  /**
   * Cold-start deep-link target — the screen the app was launched into via a
   * notification tap. Returns null if the app wasn't launched from a deep
   * link. The intent extra is consumed by the call, so re-calls return null.
   * For warm-start deep-links (app already running, notification tapped),
   * listen for the `launchedFrom` event instead.
   */
  getLaunchIntent: (): Promise<LaunchIntent | null> => Bridge.getLaunchIntent(),
};

// ─── Events ──────────────────────────────────────────────
//
// The native side emits a single stream named `ObscuraEvent` whose payloads
// share the discriminator `{ type }`. [OBSCURA_EVENT_TYPES] is the canonical
// list of event names; it MUST mirror the `BridgeEvent` enum in the native
// bridges (ObscuraBridgeModule.kt / iOS). The `_AssertEventTypesMatch` check
// below makes any drift between this list and the payload union a compile error.

export const OBSCURA_EVENT_TYPES = [
  'connectionChanged',
  'authStateChanged',
  'authFailed',
  'appStateChanged',
  'launchedFrom',
  'friendsChanged',
  'messageReceived',
  'typingChanged',
  'pushTokenReceived',
] as const;

export type ObscuraEventType = (typeof OBSCURA_EVENT_TYPES)[number];

export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'authFailed'; reason: string }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsChanged' }
  | { type: 'messageReceived'; model: string }
  | { type: 'typingChanged'; conversationId: string; userIds: string[] }
  | { type: 'pushTokenReceived'; token: string };

// Compile-time guarantee that the name list and the payload union agree in both
// directions (every listed name has a payload, and every payload is listed).
type _AssertEventTypesMatch =
  [ObscuraEventType] extends [ObscuraEvent['type']]
    ? [ObscuraEvent['type']] extends [ObscuraEventType]
      ? true
      : ['missing from OBSCURA_EVENT_TYPES', Exclude<ObscuraEvent['type'], ObscuraEventType>]
    : ['missing from ObscuraEvent union', Exclude<ObscuraEventType, ObscuraEvent['type']>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _eventTypesMatch: _AssertEventTypesMatch = true;

const emitter = new NativeEventEmitter(Bridge as any);

/** Subscribe to typed Obscura events. Returns an unsubscribe function. */
export function onObscuraEvent(handler: (event: ObscuraEvent) => void): () => void {
  const sub = emitter.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}
