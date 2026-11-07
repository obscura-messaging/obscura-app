/**
 * Dumb Tier-2 `ObscuraBridge` stub for testing `ObscuraModule.ts` and `src/state/`.
 * Holds plain arrays and state fields, records calls, and emits events on demand.
 */

import { serializeCaptionMeta, type CaptionMeta } from '../../domain/caption';
import type {
  AuthState, ConnectionState, DeviceInfo, Friend, LaunchIntent,
  LoginScenario, ObscuraBridge, ProfileItem, RawAttachment,
  RawConversationItem, RawDirectMessageItem, RawPixItem, RawStoryItem,
} from '../ObscuraModule';

export interface FakeBridgeOptions {
  userId?: string;
  username?: string;
  deviceId?: string;
}

export const FAKE_LINK_DEVICE_NAME = 'Test phone';

const rejection = (code: string, message: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

export class FakeObscuraBridge implements ObscuraBridge {
  userId = 'user_self';
  username = 'self';
  deviceId = 'device_self';
  authState: AuthState = 'loggedOut';
  connectionState: ConnectionState = 'disconnected';
  primary = true;
  loginScenario: LoginScenario = 'existingDevice';
  pushToken: string | null = null;
  clipboard: string | null = null;
  launchIntent: LaunchIntent | null = null;
  debugLog: string[] = [];
  deletedFiles: string[] = [];

  messages: RawConversationItem[] = [];
  stories: RawStoryItem[] = [];
  profiles: ProfileItem[] = [];
  friends: Friend[] = [];
  devices: DeviceInfo[] = [];

  readonly __calls: string[] = [];
  readonly __approved: string[] = [];

  private listeners = new Set<(event: any) => void>();
  private failures = new Map<string, { code: string; message: string }>();
  private deferred = new Map<string, Promise<void>>();
  private loginQueue: LoginScenario[] = [];
  private unreachable = new Set<string>();
  private sweepResult: string[] = ['directMessage', 'pix', 'story'];
  private linkCode: string | null = null;
  private linkWait: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private seq = 1_700_000_000_000;

  constructor(opts: FakeBridgeOptions = {}) {
    if (opts.userId) this.userId = opts.userId;
    if (opts.username) this.username = opts.username;
    if (opts.deviceId) this.deviceId = opts.deviceId;
  }

  private async step<T>(method: string, fn: () => T): Promise<T> {
    this.__calls.push(method);
    const gate = this.deferred.get(method);
    if (gate) {
      this.deferred.delete(method);
      await gate;
    }
    this.checkFailure(method);
    return fn();
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

  addListener(_eventName: string, handler?: (event: any) => void): { remove: () => void } {
    if (handler) this.listeners.add(handler);
    return { remove: () => { if (handler) this.listeners.delete(handler); } };
  }

  removeListeners(_count: number): void {}

  getMessages(): Promise<RawConversationItem[]> { return this.step('getMessages', () => [...this.messages]); }
  getStories(): Promise<RawStoryItem[]> { return this.step('getStories', () => [...this.stories]); }
  getProfiles(): Promise<ProfileItem[]> { return this.step('getProfiles', () => [...this.profiles]); }
  flushOutbox(): Promise<number> { return this.step('flushOutbox', () => 0); }
  sweepExpired(): Promise<string[]> { return this.step('sweepExpired', () => [...this.sweepResult]); }

  async sendMessage(peerUserId: string, content: string): Promise<string> {
    this.__calls.push('sendMessage');
    if (peerUserId.trim() === '') throw rejection('INVALID_ARGUMENT', 'peerUserId is required');
    const sentAt = ++this.seq, id = `dm_${sentAt}`;
    this.messages.push({ kind: 'message', id, peerUserId, authorUserId: this.userId, sentAt, viewedAt: null, content });
    this.checkFailure('sendMessage');
    if (this.unreachable.has(peerUserId)) throw rejection('SEND_FAILED', 'directMessage reached none of its recipients');
    return id;
  }

  async sendPix(
    peerUserId: string, mediaRef: string, contentKey: string, nonce: string,
    mediaType: string, caption: string, captionMeta: string | null, displayDuration: number,
  ): Promise<string> {
    this.__calls.push('sendPix');
    if (peerUserId.trim() === '') throw rejection('INVALID_ARGUMENT', 'peerUserId is required');
    const sentAt = ++this.seq, id = `pix_${sentAt}`;
    this.messages.push({
      kind: 'pix', id, peerUserId, authorUserId: this.userId, sentAt, viewedAt: null,
      attachment: { id: mediaRef, contentKey, nonce, mediaType }, caption, captionMeta, displayDuration,
    });
    this.checkFailure('sendPix');
    if (this.unreachable.has(peerUserId)) throw rejection('SEND_FAILED', 'pix reached none of its recipients');
    return id;
  }

  markSeen(entryId: string): Promise<void> {
    return this.step('markSeen', () => {
      const item = this.messages.find((m) => m.id === entryId);
      if (!item || item.authorUserId === this.userId || item.viewedAt !== null) return;
      item.viewedAt = ++this.seq;
    });
  }

  async postStory(
    content: string, mediaRef: string | null, contentKey: string | null,
    nonce: string | null, mediaType: string | null, captionMeta: string | null,
  ): Promise<string> {
    this.__calls.push('postStory');
    const sentAt = ++this.seq, id = `story_${sentAt}`;
    const attachment: RawAttachment | null = mediaRef && contentKey && nonce
      ? { id: mediaRef, contentKey, nonce, mediaType: mediaType ?? 'photo' } : null;
    this.stories.push({ id, authorUserId: this.userId, sentAt, content, attachment, captionMeta });
    this.checkFailure('postStory');
    if (this.friends.some((f) => this.unreachable.has(f.userId))) {
      throw rejection('SEND_FAILED', 'story reached none of its recipients');
    }
    return id;
  }

  async updateProfile(displayName: string, bio: string): Promise<void> {
    this.__calls.push('updateProfile');
    const updatedAt = ++this.seq;
    const profile: ProfileItem = { userId: this.userId, authorDeviceId: this.deviceId, updatedAt, displayName, bio };
    this.profiles = [...this.profiles.filter((p) => p.userId !== this.userId), profile];
    this.checkFailure('updateProfile');
    if (this.friends.some((f) => this.unreachable.has(f.userId))) {
      throw rejection('SEND_FAILED', 'profile reached none of its recipients');
    }
  }

  registerUser(username: string, _password: string): Promise<void> {
    return this.step('registerUser', () => { this.username = username; this.__setAuthState('authenticated'); });
  }

  login(username: string, _password: string): Promise<LoginScenario> {
    return this.step('login', () => {
      const scenario = this.loginQueue.shift() ?? this.loginScenario;
      this.loginScenario = scenario;
      if (scenario === 'existingDevice') { this.username = username; this.__setAuthState('authenticated'); }
      return scenario;
    });
  }

  resetAccount(username: string, _password: string): Promise<void> {
    return this.step('resetAccount', () => {
      this.clearLocalState(); this.username = username; this.primary = true; this.__setAuthState('authenticated');
    });
  }

  beginLink(username: string, _password: string): Promise<string> {
    return this.step('beginLink', () => { this.username = username; return (this.linkCode = `link_${++this.seq}`); });
  }

  async completeLink(): Promise<void> {
    this.__calls.push('completeLink'); this.checkFailure('completeLink');
    if (this.linkCode === null) throw rejection('INVALID_ARGUMENT', 'No link in progress');
    this.linkCode = null;
    await new Promise<void>((resolve, reject) => { this.linkWait = { resolve, reject }; });
    this.primary = false; this.__setAuthState('authenticated'); this.__setConnectionState('connected');
  }

  cancelLink(): Promise<void> {
    return this.step('cancelLink', () => { this.linkCode = null; this.settleLink(rejection('CANCELLED', 'Link cancelled')); });
  }

  private settleLink(error: Error | null): void {
    const wait = this.linkWait; this.linkWait = null;
    if (error === null) wait?.resolve(); else wait?.reject(error);
  }

  connect(): Promise<void> { return this.step('connect', () => this.__setConnectionState('connected')); }
  logout(): Promise<void> { return this.step('logout', () => this.clearLocalState()); }
  wipeDevice(): Promise<void> { return this.step('wipeDevice', () => this.clearLocalState()); }

  private clearLocalState(): void {
    this.messages = []; this.stories = []; this.profiles = []; this.friends = [];
    this.__setConnectionState('disconnected'); this.__setAuthState('loggedOut');
  }

  getConnectionState(): Promise<ConnectionState> { return this.step('getConnectionState', () => this.connectionState); }
  getAuthState(): Promise<AuthState> { return this.step('getAuthState', () => this.authState); }
  getUserId(): Promise<string | null> { return this.step('getUserId', () => (this.authState === 'authenticated' ? this.userId : null)); }
  getUsername(): Promise<string | null> { return this.step('getUsername', () => (this.authState === 'authenticated' ? this.username : null)); }
  getDeviceId(): Promise<string | null> { return this.step('getDeviceId', () => (this.authState === 'authenticated' ? this.deviceId : null)); }
  isPrimary(): Promise<boolean> { return this.step('isPrimary', () => this.authState === 'authenticated' && this.primary); }

  linkCodeDeviceName(code: string): Promise<string> {
    return this.step('linkCodeDeviceName', () => {
      if (!code.startsWith('link_')) throw rejection('INVALID_ARGUMENT', 'Invalid link code');
      return FAKE_LINK_DEVICE_NAME;
    });
  }

  approveLink(code: string): Promise<void> {
    return this.step('approveLink', () => { this.requirePrimary(); this.__approved.push(code); });
  }

  getDevices(): Promise<DeviceInfo[]> { return this.step('getDevices', () => this.devices.map((d) => ({ ...d }))); }

  unlinkDevice(deviceId: string): Promise<void> {
    return this.step('unlinkDevice', () => {
      if (deviceId === this.deviceId) {
        if (this.primary) throw rejection('INVALID_ARGUMENT', 'The primary device cannot unlink itself');
        this.clearLocalState();
        return;
      }
      this.requirePrimary();
      this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    });
  }

  removeFriend(userId: string): Promise<void> {
    return this.step('removeFriend', () => { this.requirePrimary(); this.__setFriends(this.friends.filter((f) => f.userId !== userId)); });
  }

  acceptFriend(userId: string): Promise<void> {
    return this.step('acceptFriend', () => {
      this.requirePrimary();
      const existing = this.friends.find((f) => f.userId === userId);
      if (!existing) throw new Error(`Unknown friend ${userId}`);
      this.__setFriends([...this.friends.filter((f) => f.userId !== userId), { ...existing, status: 'accepted' }]);
    });
  }

  getFriendCode(): Promise<string> { return this.step('getFriendCode', () => `${this.userId}:${this.username}`); }

  addFriendByCode(code: string): Promise<void> {
    return this.step('addFriendByCode', () => {
      this.requirePrimary();
      const [userId, username] = code.split(':');
      this.__setFriends([...this.friends, { userId, username: username ?? userId, status: 'pending_sent' }]);
    });
  }

  getFriends(): Promise<Friend[]> { return this.step('getFriends', () => [...this.friends]); }
  sendTyping(_peerUserId: string): Promise<void> { return this.step('sendTyping', () => {}); }
  stopTyping(_peerUserId: string): Promise<void> { return this.step('stopTyping', () => {}); }
  observeTyping(_peerUserId: string): Promise<void> { return this.step('observeTyping', () => {}); }
  stopObservingTyping(_peerUserId: string): Promise<void> { return this.step('stopObservingTyping', () => {}); }

  uploadAttachment(filePath: string): Promise<{ id: string; contentKey: string; nonce: string }> {
    return this.step('uploadAttachment', () => ({ id: `att_${++this.seq}`, contentKey: 'key_' + filePath.length, nonce: 'nonce' }));
  }

  downloadAttachment(id: string, _contentKey: string, _nonce: string): Promise<string> {
    return this.step('downloadAttachment', () => `/fake/cache/${id}`);
  }

  resizeImage(srcPath: string, maxDim: number, _quality: number): Promise<{ path: string; width: number; height: number }> {
    return this.step('resizeImage', () => ({ path: srcPath, width: maxDim, height: maxDim }));
  }

  writeTestImage(width: number, height: number): Promise<{ path: string; width: number; height: number }> {
    return this.step('writeTestImage', () => ({ path: '/fake/test.jpg', width, height }));
  }

  requestPushPermission(): Promise<boolean> { return this.step('requestPushPermission', () => true); }
  registerPushToken(token: string): Promise<void> { return this.step('registerPushToken', () => { this.pushToken = token; }); }
  __registeredPushToken(): string | null { return this.pushToken; }
  getDebugLog(): Promise<string[]> { return this.step('getDebugLog', () => [...this.debugLog]); }
  prewarmAudioSession(): Promise<void> { return this.step('prewarmAudioSession', () => {}); }
  deleteFile(path: string): Promise<void> { return this.step('deleteFile', () => { this.deletedFiles.push(path); }); }
  setClipboard(text: string): Promise<void> { return this.step('setClipboard', () => { this.clipboard = text; }); }
  getLaunchIntent(): Promise<LaunchIntent | null> { return this.step('getLaunchIntent', () => this.launchIntent); }

  __emit(event: Record<string, unknown>): void { for (const l of [...this.listeners]) l(event); }
  __listenerCount(): number { return this.listeners.size; }
  __failNext(method: string, code: string, message = 'fake failure'): void { this.failures.set(method, { code, message }); }
  __deferNext(method: string): () => void {
    let release!: () => void;
    this.deferred.set(method, new Promise<void>((r) => { release = r; }));
    return release;
  }
  __setUnreachable(userIds: string[]): void { this.unreachable = new Set(userIds); }
  __setSweepResult(models: string[]): void { this.sweepResult = models; }

  __deliverMessage(input: Partial<RawDirectMessageItem> = {}): RawDirectMessageItem {
    const sentAt = input.sentAt ?? ++this.seq;
    const authorUserId = input.authorUserId ?? input.peerUserId ?? 'user_peer';
    const item: RawDirectMessageItem = {
      kind: 'message', id: input.id ?? `dm_${sentAt}`,
      peerUserId: input.peerUserId ?? (authorUserId === this.userId ? 'user_peer' : authorUserId),
      authorUserId, sentAt, viewedAt: input.viewedAt ?? null, content: input.content ?? 'hello',
    };
    this.messages.push(item);
    this.__emit({ type: 'messageReceived', model: 'directMessage' });
    return item;
  }

  __deliverPix(input: {
    id?: string; peerUserId?: string; authorUserId?: string; sentAt?: number; viewedAt?: number | null;
    attachment?: RawAttachment; caption?: string | null; captionMeta?: CaptionMeta | string | null; displayDuration?: number;
  } = {}): RawPixItem {
    const sentAt = input.sentAt ?? ++this.seq;
    const authorUserId = input.authorUserId ?? input.peerUserId ?? 'user_peer';
    const item: RawPixItem = {
      kind: 'pix', id: input.id ?? `pix_${sentAt}`,
      peerUserId: input.peerUserId ?? (authorUserId === this.userId ? 'user_peer' : authorUserId),
      authorUserId, sentAt, viewedAt: input.viewedAt ?? null,
      attachment: input.attachment ?? { id: 'att_1', contentKey: 'key', nonce: 'nonce', mediaType: 'photo' },
      caption: input.caption ?? null,
      captionMeta: typeof input.captionMeta === 'object' && input.captionMeta !== null ? serializeCaptionMeta(input.captionMeta) : (input.captionMeta ?? null),
      displayDuration: input.displayDuration ?? 5,
    };
    this.messages.push(item);
    this.__emit({ type: 'messageReceived', model: 'pix' });
    return item;
  }

  __deliverSeen(input: string | { entryId: string; senderUserId?: string; viewedAt?: number; sentAt?: number }, viewedAtArg?: number): void {
    const opts = typeof input === 'string' ? { entryId: input, viewedAt: viewedAtArg } : input;
    const item = this.messages.find((m) => m.id === opts.entryId);
    if (item && item.viewedAt === null) item.viewedAt = opts.viewedAt ?? opts.sentAt ?? ++this.seq;
    this.__emit({ type: 'messageReceived', model: 'seen' });
  }

  __deliverStory(input: {
    id?: string; authorUserId?: string; sentAt?: number; content?: string; attachment?: RawAttachment | null;
    captionMeta?: CaptionMeta | string | null;
  } = {}): RawStoryItem {
    const sentAt = input.sentAt ?? ++this.seq;
    const story: RawStoryItem = {
      id: input.id ?? `story_${sentAt}`, authorUserId: input.authorUserId ?? 'user_peer',
      sentAt, content: input.content ?? '', attachment: input.attachment,
      captionMeta: typeof input.captionMeta === 'object' && input.captionMeta !== null ? serializeCaptionMeta(input.captionMeta) : (input.captionMeta ?? null),
    };
    this.stories.push(story);
    this.__emit({ type: 'messageReceived', model: 'story' });
    return story;
  }

  __deliverProfile(input: { userId: string; authorDeviceId?: string; updatedAt?: number; displayName: string; bio?: string }): ProfileItem {
    const profile: ProfileItem = {
      userId: input.userId, authorDeviceId: input.authorDeviceId ?? 'device_peer',
      updatedAt: input.updatedAt ?? ++this.seq, displayName: input.displayName, bio: input.bio ?? '',
    };
    this.profiles = [...this.profiles.filter((p) => p.userId !== input.userId), profile];
    this.__emit({ type: 'messageReceived', model: 'profile' });
    return profile;
  }

  __authenticate(opts: FakeBridgeOptions = {}): void {
    if (opts.userId !== undefined) this.userId = opts.userId;
    if (opts.username !== undefined) this.username = opts.username;
    if (opts.deviceId !== undefined) this.deviceId = opts.deviceId;
    this.__setAuthState('authenticated');
  }

  __setFriends(friends: Friend[]): void { this.friends = friends; this.__emit({ type: 'friendsChanged' }); }
  __setAuthState(state: AuthState): void { this.authState = state; this.__emit({ type: 'authStateChanged', state }); }
  __setConnectionState(state: ConnectionState): void { this.connectionState = state; this.__emit({ type: 'connectionChanged', state }); }
  __setLoginScenario(...scenarios: LoginScenario[]): void {
    this.loginQueue = [...scenarios];
    this.loginScenario = scenarios[0] ?? 'existingDevice';
  }
  __setPrimary(primary: boolean): void { this.primary = primary; }
  __setDevices(devices: DeviceInfo[]): void { this.devices = devices; }
  __approvePendingLink(): void { this.settleLink(null); }
  __expirePendingLink(): void { this.settleLink(rejection('LINK_FAILED', 'Link session expired')); }

  __reset(): void {
    this.messages = []; this.stories = []; this.profiles = []; this.friends = []; this.devices = [];
    this.__calls.length = 0; this.__approved.length = 0;
    this.listeners.clear(); this.failures.clear(); this.deferred.clear(); this.unreachable.clear();
    this.loginQueue = [];
    this.sweepResult = ['directMessage', 'pix', 'story'];
    this.debugLog = []; this.deletedFiles = [];
    this.pushToken = null; this.clipboard = null; this.launchIntent = null;
    this.loginScenario = 'existingDevice'; this.primary = true;
    this.linkCode = null; this.linkWait = null;
    this.userId = 'user_self'; this.username = 'self'; this.deviceId = 'device_self';
    this.authState = 'loggedOut'; this.connectionState = 'disconnected';
    this.seq = 1_700_000_000_000;
  }
}
