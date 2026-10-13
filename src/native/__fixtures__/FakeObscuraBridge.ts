/**
 * An in-memory stand-in for the native `ObscuraBridge`.
 *
 * Jest has no native module or event emitter, so tests install this fake before
 * importing `ObscuraModule`. It persists entries and inbox rows and emits events,
 * allowing tests to exercise the real TypeScript bridge facade.
 *
 * It deliberately does not model kit internals:
 *
 *   - no crypto, no Signal sessions, no network, no persistence across instances;
 *   - `userId` / `deviceId` are whatever you set, with no authentication of any kind;
 *   - it models the **bridge contract**, not the kit's internals.
 *
 * The properties that matter are modelled faithfully because the app's correctness depends on them:
 * `inboxPeek` is side-effect free, ids are monotonic and never reused, `entryPut` is a BLIND upsert
 * (the app decides who wins), and `sendEntry` produces no local row — the sender writes its own copy.
 */

import type { AuthState, Friend, InboxRow, LoginScenario, SendReport, StoredEntry, SubmissionResult } from '../ObscuraModule';

type FakeInboxRow = InboxRow & { envelopeId: string };

export interface FakeBridgeOptions {
  userId?: string;
  username?: string;
  deviceId?: string;
}

export class FakeObscuraBridge {
  // ─── Session ───────────────────────────────────────────
  userId: string;
  username: string;
  deviceId: string;
  authState: AuthState = 'loggedOut';
  connectionState: 'disconnected' | 'connecting' | 'reconnecting' | 'connected' = 'disconnected';

  // ─── Stores ────────────────────────────────────────────
  private friends: Friend[] = [];
  private listeners = new Set<(event: any) => void>();
  private debugLog: string[] = [];
  private pushToken: string | null = null;
  private loginScenario: LoginScenario = 'existingDevice';

  /**
   * Monotonic clock. Real `Date.now()` has millisecond resolution, so two writes in the same tick
   * collide — and an equal-timestamp collision is resolved by `authorDeviceId`, which in a
   * single-device test is *the same value*, making the outcome arrival-order dependent. That is a
   * flake generator. A counter makes local writes strictly ordered; tests that care about ties set
   * timestamps explicitly through `__deliverEntry`.
   */
  private clock = 1_700_000_000_000;
  private nextTimestamp(): number {
    return ++this.clock;
  }

  /**
   * Every bridge call, in order, as `"methodName"`. Use it to assert what actually crossed the
   * bridge — the one thing a fake can prove that the real kit cannot, since the boundary is the
   * contract under test.
   */
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

  /** What `sendEntry` put on the wire, in order. The app's outgoing audience decisions, observable. */
  readonly __sent: Array<{
    recipientUserIds: string[]; modelKey: string; entryId: string;
    sentAt: number; payloadJson: string;
  }> = [];

  /** Rows the app discarded, with the reason. Data loss must be visible in a test, not silent. */
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
    // Side-effect free: peeking twice without consuming returns the same rows. Copies
    // are returned so a test mutating a row cannot corrupt the store and mask a bug.
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
    // Deletes the rows itself rather than delegating to `inboxConsume`. Delegating pushed an extra
    // `'inboxConsume'` onto `__calls`, so an ordering assertion of the shape
    // `__calls.indexOf('inboxConsume')` read a DISCARD as a consume as soon as a batch contained
    // both — and the assertion it silently weakened is the one guarding write-before-consume.
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
    // BLIND, exactly like the kits: an older write overwrites a newer one, because by the time a
    // write gets here the app has already decided who wins. A double that merged would hide an app
    // that forgot to.
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
    // No local row and no inbox row: the sender writes its own copy, so a test that forgets to sees
    // an empty store.
    this.__sent.push({ recipientUserIds, modelKey, entryId, sentAt, payloadJson });
    return {
      recipients: recipientUserIds.map((userId): SubmissionResult => this.unreachable.has(userId)
        ? { userId, deviceId: null, status: 'rejected', error: 'No devices found' }
        : { userId, deviceId: `${userId}-device`, status: 'accepted', error: null }),
      selfSync: [],
    };
  }

  // ─── Test controls (`__` prefix — NOT part of the native surface) ───

  /** Emit a raw event exactly as the native side would. */
  __emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event);
  }

  /**
   * Simulate a message arriving: the kit persists an inbox row, then notifies. Merge-before-notify
   * is the kit's order and the reason "event → drain" is safe.
   *
   * Defaults describe a well-formed APP_ENTRY, so a test only states what it is varying.
   *
   * Deduped on `envelopeId`, as in both kits: passing the same `envelopeId` again returns the
   * existing row rather than adding one.
   */
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

  /**
   * Put the double in the state every drain test needs: an authenticated session.
   *
   * `getUserId()` resolves `null` while logged out, and the drain refuses to authorize anything
   * without an identity — so a test that skips this drains nothing, which is the correct behaviour
   * and a confusing way to discover it.
   */
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

  /** Flip connection state and emit. */
  __setConnectionState(state: 'disconnected' | 'connecting' | 'reconnecting' | 'connected'): void {
    this.connectionState = state;
    this.__emit({ type: 'connectionChanged', state });
  }

  /** Raw entry table for a model, for assertions the public API cannot express. */
  /**
   * Clear all state, **in place**.
   *
   * In place is not a detail: `ObscuraModule.ts` captures its `Bridge` reference at import time and
   * caches the `NativeEventEmitter` built from it, so swapping in a new instance between tests
   * would leave the module pointing at the old one. Everything below mutates rather than reassigns
   * for that reason. Called automatically from `beforeEach` by the jest setup.
   */
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
    this.userId = 'user_self';
    this.username = 'self';
    this.deviceId = 'device_self';
    this.authState = 'loggedOut';
    this.connectionState = 'disconnected';
    this.clock = 1_700_000_000_000;
  }

  /** How many handlers are subscribed. Catches leaked subscriptions in unmount tests. */
  __listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Make the next call to `method` reject, as a native failure would.
   *
   * The app's error paths are otherwise untestable: every call resolves, so `.catch(...)` branches
   * are dead code under test. `code` mirrors `ObscuraErrorCode`.
   */
  private failures = new Map<string, { code: string; message: string }>();
  __failNext(method: string, code: string, message = 'fake failure'): void {
    this.failures.set(method, { code, message });
  }

  private checkFailure(method: string): void {
    const f = this.failures.get(method);
    if (!f) return;
    this.failures.delete(method);
    const err: Error & { code?: string } = new Error(f.message);
    err.code = f.code;
    throw err;
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

  async loginAndProvision(username: string, _password: string): Promise<void> {
    this.record('loginAndProvision');
    this.checkFailure('loginAndProvision');
    this.username = username;
    this.__setAuthState('authenticated');
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

  async getConnectionState(): Promise<string> {
    this.record('getConnectionState');
    return this.connectionState;
  }
  async getAuthState(): Promise<string> {
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

  // ─── Friends ───────────────────────────────────────────

  async removeFriend(userId: string): Promise<void> {
    this.record('removeFriend');
    this.checkFailure('removeFriend');
    this.__setFriends(this.friends.filter((f) => f.userId !== userId));
  }

  async acceptFriend(userId: string): Promise<void> {
    this.record('acceptFriend');
    this.checkFailure('acceptFriend');
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
  //
  // Path-based, as the real bridge is: JS never holds the bytes. These return plausible values and
  // touch no filesystem — a test asserting on file contents is testing the fake, not the app.

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
