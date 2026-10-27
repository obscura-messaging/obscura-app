/**
 * An in-memory `ObscuraBridge` for Jest. It models the bridge contract, not the kit: no crypto,
 * network or authentication. What the app relies on is faithful: `inboxPeek` has no side effects,
 * inbox ids are never reused, `entryPut` is a blind upsert, `sendEntry` stores no local row, friend
 * and device changes are primary only, and `completeLink` waits until the test approves, expires or
 * cancels the pending link.
 */

import type { AuthState, ConnectionState, DeviceInfo, Friend, ObscuraBridge, InboxRow, LoginScenario, SendReport, StoredEntry, SubmissionResult } from '../ObscuraModule';

type FakeInboxRow = InboxRow & { envelopeId: string };

export interface FakeBridgeOptions {
  userId?: string;
  username?: string;
  deviceId?: string;
}

export class FakeObscuraBridge implements ObscuraBridge {
  // ─── Session ───────────────────────────────────────────
  userId: string;
  username: string;
  deviceId: string;
  authState: AuthState = 'loggedOut';
  connectionState: ConnectionState = 'disconnected';

  // ─── Stores ────────────────────────────────────────────
  private friends: Friend[] = [];
  private listeners = new Set<(event: any) => void>();
  private debugLog: string[] = [];
  private pushToken: string | null = null;
  private loginScenario: LoginScenario = 'existingDevice';
  private primary = true;
  private devices: DeviceInfo[] = [];
  private linkCode: string | null = null;
  private linkWait: { resolve: () => void; reject: (e: Error) => void } | null = null;

  /** Codes `approveLink` accepted, in order. */
  readonly __approved: string[] = [];

  /** Strictly increasing timestamps, so same-tick writes never tie. */
  private clock = 1_700_000_000_000;
  private nextTimestamp(): number {
    return ++this.clock;
  }

  /** Every bridge call, in order. */
  readonly __calls: string[] = [];

  constructor(opts: FakeBridgeOptions = {}) {
    this.userId = opts.userId ?? 'user_self';
    this.username = opts.username ?? 'self';
    this.deviceId = opts.deviceId ?? 'device_self';
  }

  private record(method: string): void {
    this.__calls.push(method);
  }

  // ─── The thin kit surface ──────────────────────────────────────────────

  private inbox: FakeInboxRow[] = [];
  /** Never reused, exactly like the kits' `AUTOINCREMENT`: a drained inbox must not reissue ids. */
  private nextInboxId = 1;
  private storedEntries = new Map<string, Map<string, StoredEntry>>();

  /** What `sendEntry` put on the wire, in order. */
  readonly __sent: Array<{
    recipientUserIds: string[]; modelKey: string; entryId: string;
    sentAt: number; payloadJson: string;
  }> = [];

  /** Rows the app discarded, with the reason. */
  readonly __discarded: Array<{ ids: number[]; reason: string }> = [];

  private entryTable(model: string): Map<string, StoredEntry> {
    let t = this.storedEntries.get(model);
    if (!t) {
      t = new Map();
      this.storedEntries.set(model, t);
    }
    return t;
  }

  async inboxPeek(limit: number): Promise<InboxRow[]> {
    this.record('inboxPeek');
    this.checkFailure('inboxPeek');
    // Copies, so a test mutating a row cannot corrupt the inbox.
    return this.inbox.slice(0, limit).map(({ envelopeId: _envelopeId, ...row }) => ({ ...row }));
  }

  async inboxConsume(ids: number[]): Promise<void> {
    this.record('inboxConsume');
    this.checkFailure('inboxConsume');
    const drop = new Set(ids);
    this.inbox = this.inbox.filter((r) => !drop.has(r.id));
  }

  async inboxDiscard(ids: number[], reason: string): Promise<void> {
    this.record('inboxDiscard');
    this.checkFailure('inboxDiscard');
    if (ids.length === 0) return; // an empty discard is not a data-loss event
    this.__discarded.push({ ids, reason });
    // Not via `inboxConsume`, which would record a consume in `__calls`.
    const drop = new Set(ids);
    this.inbox = this.inbox.filter((r) => !drop.has(r.id));
  }

  async inboxDepth(): Promise<number> {
    this.record('inboxDepth');
    this.checkFailure('inboxDepth');
    return this.inbox.length;
  }

  async entryPut(
    model: string,
    id: string,
    dataJson: string,
    sentAt: number,
    authorDeviceId: string,
    localMetadata: string | null,
  ): Promise<void> {
    this.record('entryPut');
    this.checkFailure('entryPut');
    if (typeof dataJson !== 'string') {
      throw new Error('entryPut expects a JSON string across the bridge, got ' + typeof dataJson);
    }
    this.entryTable(model).set(id, {
      id, data: dataJson, sentAt, authorDeviceId, localMetadata,
    });
  }

  async entryAll(model: string): Promise<StoredEntry[]> {
    this.record('entryAll');
    this.checkFailure('entryAll');
    return [...this.entryTable(model).values()].map((e) => ({ ...e }));
  }

  async entryGet(model: string, ids: string[]): Promise<StoredEntry[]> {
    this.record('entryGet');
    this.checkFailure('entryGet');
    const table = this.entryTable(model);
    return ids.flatMap((id) => {
      const e = table.get(id);
      return e === undefined ? [] : [{ ...e }];
    });
  }

  async entryErase(model: string, ids: string[]): Promise<void> {
    this.record('entryErase');
    this.checkFailure('entryErase');
    // Missing ids are a no-op, like the kits.
    for (const id of ids) this.entryTable(model).delete(id);
  }

  /** Users whose sends the kit reports rejected, as it does for a user with no devices. */
  private unreachable = new Set<string>();
  __setUnreachable(userIds: string[]): void {
    this.unreachable = new Set(userIds);
  }

  async sendEntry(
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<SendReport> {
    this.record('sendEntry');
    this.checkFailure('sendEntry');
    this.__sent.push({ recipientUserIds, modelKey, entryId, sentAt, payloadJson });
    return {
      recipients: recipientUserIds.map((userId): SubmissionResult => this.unreachable.has(userId)
        ? { userId, deviceId: null, status: 'rejected', error: 'No devices found' }
        : { userId, deviceId: `${userId}-device`, status: 'accepted', error: null }),
      selfSync: [],
    };
  }

  // ─── Test controls (not part of the native surface) ───

  /** Emit a raw event exactly as the native side would. */
  __emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event);
  }

  /** Persist an inbox row and notify, as the kit does. Deduped on `envelopeId`. */
  __deliverInbox(
    row: Partial<InboxRow> & { payload: string; envelopeId?: string },
  ): FakeInboxRow {
    const id = this.nextInboxId;
    const full: FakeInboxRow = {
      id,
      envelopeId: `env_${id}`,
      kind: 'APP_ENTRY',
      senderUserId: 'user_peer',
      senderDeviceId: 'device_peer',
      modelKey: 'directMessage',
      entryId: `entry_${id}`,
      sentAt: this.nextTimestamp(),
      ...row,
    };
    const existing = this.inbox.find((r) => r.envelopeId === full.envelopeId);
    if (existing) return { ...existing };
    this.nextInboxId += 1;
    this.inbox.push(full);
    this.__emit({ type: 'messageReceived', model: full.modelKey ?? '' });
    return full;
  }

  /** An authenticated session; without one, `getUserId()` is null and the drain stores nothing. */
  __authenticate(opts: FakeBridgeOptions = {}): void {
    if (opts.userId !== undefined) this.userId = opts.userId;
    if (opts.username !== undefined) this.username = opts.username;
    if (opts.deviceId !== undefined) this.deviceId = opts.deviceId;
    this.__setAuthState('authenticated');
  }

  /** Set the friend graph and emit its payload-free wake event. */
  __setFriends(friends: Friend[]): void {
    this.friends = friends;
    this.__emit({ type: 'friendsChanged' });
  }

  /** Flip auth state and emit, as login/logout does. */
  __setAuthState(state: AuthState): void {
    this.authState = state;
    this.__emit({ type: 'authStateChanged', state });
  }

  /** What the next `login` calls resolve to. Only `existingDevice` authenticates, as in the kits. */
  __setLoginScenario(scenario: LoginScenario): void {
    this.loginScenario = scenario;
  }

  /** Whether this device is the account's primary. */
  __setPrimary(primary: boolean): void {
    this.primary = primary;
  }

  /** The account's devices as `getDevices` reports them. */
  __setDevices(devices: DeviceInfo[]): void {
    this.devices = devices;
  }

  /** The primary approves the pending link: `completeLink` provisions this device and resolves. */
  __approvePendingLink(): void {
    this.settleLink(null);
  }

  /** The pending link session expires: `completeLink` rejects `LINK_FAILED`. */
  __expirePendingLink(): void {
    this.settleLink(rejection('LINK_FAILED', 'Link session expired'));
  }

  /** Flip connection state and emit. */
  __setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.__emit({ type: 'connectionChanged', state });
  }

  /** Clear all state in place: `ObscuraModule` holds this instance from import time. */
  __reset(): void {
    this.inbox.length = 0;
    this.nextInboxId = 1;
    this.storedEntries.clear();
    this.__sent.length = 0;
    this.__discarded.length = 0;
    this.__purged.length = 0;
    this.friends = [];
    this.listeners.clear();
    this.debugLog.length = 0;
    this.failures.clear();
    this.unreachable.clear();
    this.__calls.length = 0;
    this.pushToken = null;
    this.loginScenario = 'existingDevice';
    this.primary = true;
    this.devices = [];
    this.linkCode = null;
    this.linkWait = null;
    this.__approved.length = 0;
    this.userId = 'user_self';
    this.username = 'self';
    this.deviceId = 'device_self';
    this.authState = 'loggedOut';
    this.connectionState = 'disconnected';
    this.clock = 1_700_000_000_000;
  }

  /** How many handlers are subscribed. */
  __listenerCount(): number {
    return this.listeners.size;
  }

  /** Make the next call to `method` reject with `code`, as a native failure would. */
  private failures = new Map<string, { code: string; message: string }>();
  __failNext(method: string, code: string, message = 'fake failure'): void {
    this.failures.set(method, { code, message });
  }

  private checkFailure(method: string): void {
    const f = this.failures.get(method);
    if (!f) return;
    this.failures.delete(method);
    throw rejection(f.code, f.message);
  }

  private requirePrimary(): void {
    if (!this.primary) throw rejection('NOT_PRIMARY', 'Only the primary device can do this');
  }

  // ─── Event subscription (what `NativeEventEmitter` drives) ───

  addListener(_eventName: string, handler?: (event: any) => void): { remove: () => void } {
    if (handler) this.listeners.add(handler);
    return {
      remove: () => {
        if (handler) this.listeners.delete(handler);
      },
    };
  }

  removeListeners(_count: number): void {
    // RN calls this on teardown; the per-subscription `remove()` above does the real work.
  }

  // ─── Auth ──────────────────────────────────────────────

  async registerUser(username: string, _password: string): Promise<void> {
    this.record('registerUser');
    this.checkFailure('registerUser');
    this.username = username;
    this.__setAuthState('authenticated');
  }

  async login(username: string, _password: string): Promise<LoginScenario> {
    this.record('login');
    this.checkFailure('login');
    if (this.loginScenario === 'existingDevice') {
      this.username = username;
      this.__setAuthState('authenticated');
    }
    return this.loginScenario;
  }

  async provisionPrimary(username: string, _password: string): Promise<void> {
    this.record('provisionPrimary');
    this.checkFailure('provisionPrimary');
    this.username = username;
    this.primary = true;
    this.__setAuthState('authenticated');
  }

  async resetAccount(_username: string, _password: string): Promise<void> {
    this.record('resetAccount');
    this.checkFailure('resetAccount');
    this.clearLocalState();
  }

  async beginLink(username: string, _password: string): Promise<string> {
    this.record('beginLink');
    this.checkFailure('beginLink');
    this.username = username;
    this.linkCode = `link_${this.nextTimestamp()}`;
    return this.linkCode;
  }

  async completeLink(): Promise<void> {
    this.record('completeLink');
    this.checkFailure('completeLink');
    if (this.linkCode === null) throw rejection('INVALID_ARGUMENT', 'No link in progress');
    this.linkCode = null;
    await new Promise<void>((resolve, reject) => { this.linkWait = { resolve, reject }; });
    this.primary = false;
    this.__setAuthState('authenticated');
    this.__setConnectionState('connected');
  }

  async cancelLink(): Promise<void> {
    this.record('cancelLink');
    this.linkCode = null;
    this.settleLink(rejection('CANCELLED', 'Link cancelled'));
  }

  private settleLink(error: Error | null): void {
    const wait = this.linkWait;
    this.linkWait = null;
    if (error === null) wait?.resolve();
    else wait?.reject(error);
  }

  async connect(): Promise<void> {
    this.record('connect');
    this.checkFailure('connect');
    this.__setConnectionState('connected');
  }

  async logout(): Promise<void> {
    this.record('logout');
    this.checkFailure('logout');
    this.clearLocalState();
  }

  async wipeDevice(): Promise<void> {
    this.record('wipeDevice');
    this.checkFailure('wipeDevice');
    this.clearLocalState();
  }

  private clearLocalState(): void {
    this.inbox.length = 0;
    this.nextInboxId = 1;
    this.storedEntries.clear();
    this.__sent.length = 0;
    this.__discarded.length = 0;
    this.friends = [];
    this.__setConnectionState('disconnected');
    this.__setAuthState('loggedOut');
  }

  // ─── State ─────────────────────────────────────────────

  async getConnectionState(): Promise<ConnectionState> {
    this.record('getConnectionState');
    return this.connectionState;
  }
  async getAuthState(): Promise<AuthState> {
    this.record('getAuthState');
    return this.authState;
  }
  async getUserId(): Promise<string | null> {
    this.record('getUserId');
    return this.authState === 'authenticated' ? this.userId : null;
  }
  async getUsername(): Promise<string | null> {
    this.record('getUsername');
    return this.authState === 'authenticated' ? this.username : null;
  }
  async getDeviceId(): Promise<string | null> {
    this.record('getDeviceId');
    return this.authState === 'authenticated' ? this.deviceId : null;
  }
  async isPrimary(): Promise<boolean> {
    this.record('isPrimary');
    return this.authState === 'authenticated' && this.primary;
  }

  // ─── Devices ───────────────────────────────────────────

  async approveLink(code: string): Promise<void> {
    this.record('approveLink');
    this.checkFailure('approveLink');
    this.requirePrimary();
    this.__approved.push(code);
  }

  async getDevices(): Promise<DeviceInfo[]> {
    this.record('getDevices');
    this.checkFailure('getDevices');
    return this.devices.map((d) => ({ ...d }));
  }

  async unlinkDevice(deviceId: string): Promise<void> {
    this.record('unlinkDevice');
    this.checkFailure('unlinkDevice');
    if (deviceId === this.deviceId) {
      if (this.primary) throw rejection('INVALID_ARGUMENT', 'The primary device cannot unlink itself');
      this.clearLocalState();
      return;
    }
    this.requirePrimary();
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
  }

  // ─── Friends ───────────────────────────────────────────

  async removeFriend(userId: string): Promise<void> {
    this.record('removeFriend');
    this.checkFailure('removeFriend');
    this.requirePrimary();
    this.__setFriends(this.friends.filter((f) => f.userId !== userId));
  }

  async acceptFriend(userId: string): Promise<void> {
    this.record('acceptFriend');
    this.checkFailure('acceptFriend');
    this.requirePrimary();
    const existing = this.friends.find((f) => f.userId === userId);
    if (!existing) throw new Error(`Unknown friend ${userId}`);
    const rest = this.friends.filter((f) => f.userId !== userId);
    this.__setFriends([...rest, { ...existing, status: 'accepted' }]);
  }

  async getFriendCode(): Promise<string> {
    this.record('getFriendCode');
    return `${this.userId}:${this.username}`;
  }

  async addFriendByCode(code: string): Promise<void> {
    this.record('addFriendByCode');
    this.checkFailure('addFriendByCode');
    this.requirePrimary();
    const [userId, username] = code.split(':');
    this.__setFriends([
      ...this.friends,
      { userId, username: username ?? userId, status: 'pending_sent' },
    ]);
  }

  async getFriends(): Promise<Friend[]> {
    this.record('getFriends');
    return [...this.friends];
  }

  // ─── Signals ───────────────────────────────────────────

  async sendTyping(_recipientUserIds: string[], _conversationId: string): Promise<void> {
    this.record('sendTyping');
  }
  async stopTyping(_recipientUserIds: string[], _conversationId: string): Promise<void> {
    this.record('stopTyping');
  }
  async observeTyping(_conversationId: string): Promise<void> {
    this.record('observeTyping');
  }
  async stopObservingTyping(_conversationId: string): Promise<void> {
    this.record('stopObservingTyping');
  }

  // ─── Attachments and media ─────────────────────────────

  async uploadAttachment(filePath: string): Promise<{ id: string; contentKey: string; nonce: string }> {
    this.record('uploadAttachment');
    this.checkFailure('uploadAttachment');
    return { id: `att_${this.nextTimestamp()}`, contentKey: 'key_' + filePath.length, nonce: 'nonce' };
  }

  async downloadAttachment(id: string, _contentKey: string, _nonce: string): Promise<string> {
    this.record('downloadAttachment');
    this.checkFailure('downloadAttachment');
    return `/fake/cache/${id}`;
  }

  /** Attachment ids passed to `purgeAttachment`, in order. */
  __purged: string[] = [];

  async purgeAttachment(id: string): Promise<void> {
    this.record('purgeAttachment');
    this.checkFailure('purgeAttachment');
    this.__purged.push(id);
  }

  async resizeImage(srcPath: string, maxDim: number, _quality: number): Promise<{ path: string; width: number; height: number }> {
    this.record('resizeImage');
    return { path: srcPath, width: maxDim, height: maxDim };
  }

  async writeTestImage(width: number, height: number): Promise<{ path: string; width: number; height: number }> {
    this.record('writeTestImage');
    return { path: '/fake/test.jpg', width, height };
  }

  // ─── Push ──────────────────────────────────────────────

  async requestPushPermission(): Promise<boolean> {
    this.record('requestPushPermission');
    this.checkFailure('requestPushPermission');
    return true;
  }

  async registerPushToken(token: string): Promise<void> {
    this.record('registerPushToken');
    this.checkFailure('registerPushToken');
    this.pushToken = token;
  }

  /** The token the app last registered, or null. */
  __registeredPushToken(): string | null {
    return this.pushToken;
  }

  // ─── Misc ──────────────────────────────────────────────

  async getDebugLog(): Promise<string[]> {
    this.record('getDebugLog');
    return [...this.debugLog];
  }
  async prewarmAudioSession(): Promise<void> {
    this.record('prewarmAudioSession');
  }
  async deleteFile(_path: string): Promise<void> {
    this.record('deleteFile');
  }
  async setClipboard(_text: string): Promise<void> {
    this.record('setClipboard');
  }
  async getLaunchIntent(): Promise<{ screen: string } | null> {
    this.record('getLaunchIntent');
    return null;
  }
}

/** A rejection as the native side delivers it: an `Error` with a `code`. */
function rejection(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
