/**
 * An in-memory `ObscuraBridge` for Jest. It models the bridge contract, not the kit: no crypto,
 * network or authentication. What the app relies on is faithful: messages/pix, stories, and
 * profiles are persisted with outbox `undelivered` flags, tombstones block replayed erased entries,
 * seen receipts expire messages/pix after 15m (capped by 30d max age), stories expire after 24h,
 * profiles merge by `(updatedAt, authorDeviceId)`, friend and device changes are primary only, and
 * `completeLink` waits until the test approves, expires or cancels the pending link.
 */

import type {
  AuthState, ConnectionState, ConversationItem, DeviceInfo, Friend,
  LoginScenario, ObscuraBridge, ProfileItem, StoryItem,
} from '../ObscuraModule';

export const EXPIRE_AFTER_MS = 15 * 60 * 1000;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const STORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type StoredConversationItem = ConversationItem & { undelivered: boolean };
type StoredStoryItem = StoryItem & { undelivered: boolean };
type StoredProfileItem = ProfileItem & { undelivered: boolean };

export interface SentRecord {
  recipientUserIds: string[];
  modelKey: 'directMessage' | 'pix' | 'seen' | 'story' | 'profile';
  entryId: string;
  sentAt: number;
  payload: Record<string, unknown>;
}

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

  // ─── Typed domain stores ───────────────────────────────────────────────

  private messages = new Map<string, StoredConversationItem>();
  private stories = new Map<string, StoredStoryItem>();
  private profiles = new Map<string, StoredProfileItem>();
  /** Erased entry IDs mapped to their `erasedAt` timestamp. */
  private tombstones = new Map<string, number>();
  /** Out-of-order seen receipts that arrived before their target message/pix. */
  private pendingReceipts = new Map<string, { senderUserId: string; viewedAt: number; sentAt: number }>();
  /** Local `markSeen` calls whose outgoing receipt could not be delivered yet. */
  private undeliveredReceipts = new Map<string, { peerUserId: string; receiptId: string; viewedAt: number }>();

  /** What outgoing domain operations put on the wire, in order. */
  readonly __sent: SentRecord[] = [];

  /** Users whose sends the kit reports rejected, as it does for a user with no devices. */
  private unreachable = new Set<string>();
  __setUnreachable(userIds: string[]): void {
    this.unreachable = new Set(userIds);
  }

  private acceptedFriendIds(): string[] {
    return this.friends
      .filter((f) => f.status === 'accepted' && f.userId !== this.userId)
      .map((f) => f.userId);
  }

  private canDeliverTo(recipients: readonly string[]): boolean {
    return recipients.length === 0 || recipients.some((userId) => !this.unreachable.has(userId));
  }

  private deliverOutgoing(
    method: string,
    recipientUserIds: string[],
    modelKey: SentRecord['modelKey'],
    entryId: string,
    sentAt: number,
    payload: Record<string, unknown>,
    markUndelivered: () => void,
  ): void {
    const f = this.failures.get(method);
    if (f) {
      this.failures.delete(method);
      markUndelivered();
      throw rejection(f.code, f.message);
    }
    if (!this.canDeliverTo(recipientUserIds)) {
      markUndelivered();
      throw rejection('SEND_FAILED', `${modelKey} reached none of its recipients: No devices found`);
    }
    this.__sent.push({ recipientUserIds, modelKey, entryId, sentAt, payload });
  }

  async getMessages(): Promise<ConversationItem[]> {
    this.record('getMessages');
    this.checkFailure('getMessages');
    return [...this.messages.values()]
      .sort((a, b) => a.sentAt - b.sentAt)
      .map(({ undelivered: _undelivered, ...item }) => ({ ...item }));
  }

  async sendMessage(peerUserId: string, content: string): Promise<string> {
    this.record('sendMessage');
    this.checkPreStoreFailure('sendMessage');
    if (peerUserId.trim() === '') {
      throw rejection('INVALID_ARGUMENT', 'peerUserId is required');
    }
    const sentAt = this.nextTimestamp();
    const id = `dm_${sentAt}`;
    const item: StoredConversationItem = {
      id,
      peerUserId,
      kind: 'message',
      authorUserId: this.userId,
      sentAt,
      viewedAt: null,
      content,
      mediaRef: null,
      contentKey: null,
      nonce: null,
      mediaType: null,
      caption: null,
      captionMeta: null,
      displayDuration: 0,
      undelivered: false,
    };
    this.messages.set(id, item);
    this.deliverOutgoing(
      'sendMessage',
      [peerUserId],
      'directMessage',
      id,
      sentAt,
      { peerUserId, content },
      () => { item.undelivered = true; },
    );
    return id;
  }

  async sendPix(
    peerUserId: string,
    mediaRef: string,
    contentKey: string,
    nonce: string,
    mediaType: string,
    caption: string,
    captionMeta: string | null,
    displayDuration: number,
  ): Promise<string> {
    this.record('sendPix');
    this.checkPreStoreFailure('sendPix');
    if (peerUserId.trim() === '') {
      throw rejection('INVALID_ARGUMENT', 'peerUserId is required');
    }
    const sentAt = this.nextTimestamp();
    const id = `pix_${sentAt}`;
    const item: StoredConversationItem = {
      id,
      peerUserId,
      kind: 'pix',
      authorUserId: this.userId,
      sentAt,
      viewedAt: null,
      content: '',
      mediaRef,
      contentKey,
      nonce,
      mediaType,
      caption,
      captionMeta,
      displayDuration,
      undelivered: false,
    };
    this.messages.set(id, item);
    this.deliverOutgoing(
      'sendPix',
      [peerUserId],
      'pix',
      id,
      sentAt,
      { peerUserId, mediaRef, contentKey, nonce, mediaType, caption, captionMeta, displayDuration },
      () => { item.undelivered = true; },
    );
    return id;
  }

  async markSeen(entryId: string): Promise<void> {
    this.record('markSeen');
    this.checkPreStoreFailure('markSeen');
    const item = this.messages.get(entryId);
    if (!item || item.authorUserId === this.userId) {
      this.checkFailure('markSeen');
      return;
    }
    if (item.viewedAt === null) {
      const viewedAt = this.nextTimestamp();
      item.viewedAt = viewedAt;
      const receiptId = `seen_${item.kind === 'pix' ? 'pix' : 'directMessage'}_${entryId}`;
      this.deliverOutgoing(
        'markSeen',
        [item.peerUserId],
        'seen',
        receiptId,
        viewedAt,
        { entryId, viewedAt },
        () => { this.undeliveredReceipts.set(entryId, { peerUserId: item.peerUserId, receiptId, viewedAt }); },
      );
    } else {
      this.checkFailure('markSeen');
    }
  }

  async getStories(): Promise<StoryItem[]> {
    this.record('getStories');
    this.checkFailure('getStories');
    return [...this.stories.values()]
      .filter((s) => s.sentAt + STORY_MAX_AGE_MS > this.clock)
      .sort((a, b) => a.sentAt - b.sentAt)
      .map(({ undelivered: _undelivered, ...story }) => ({ ...story }));
  }

  async postStory(
    content: string,
    mediaRef: string | null,
    contentKey: string | null,
    nonce: string | null,
    mediaType: string | null,
    captionMeta: string | null,
  ): Promise<string> {
    this.record('postStory');
    this.checkPreStoreFailure('postStory');
    const sentAt = this.nextTimestamp();
    const id = `story_${sentAt}`;
    const story: StoredStoryItem = {
      id,
      authorUserId: this.userId,
      sentAt,
      content,
      mediaRef,
      contentKey,
      nonce,
      mediaType,
      captionMeta,
      undelivered: false,
    };
    this.stories.set(id, story);
    const recipients = this.acceptedFriendIds();
    this.deliverOutgoing(
      'postStory',
      recipients,
      'story',
      id,
      sentAt,
      { content, mediaRef, contentKey, nonce, mediaType, captionMeta },
      () => { story.undelivered = true; },
    );
    return id;
  }

  async getProfiles(): Promise<ProfileItem[]> {
    this.record('getProfiles');
    this.checkFailure('getProfiles');
    return [...this.profiles.values()].map(({ undelivered: _undelivered, ...profile }) => ({ ...profile }));
  }

  async updateProfile(displayName: string, bio: string): Promise<void> {
    this.record('updateProfile');
    this.checkPreStoreFailure('updateProfile');
    const existing = this.profiles.get(this.userId);
    const now = this.nextTimestamp();
    const updatedAt = existing ? Math.max(now, existing.updatedAt + 1) : now;
    const profile: StoredProfileItem = {
      userId: this.userId,
      authorDeviceId: this.deviceId,
      updatedAt,
      displayName,
      bio,
      undelivered: false,
    };
    this.profiles.set(this.userId, profile);
    const recipients = this.acceptedFriendIds();
    this.deliverOutgoing(
      'updateProfile',
      recipients,
      'profile',
      `profile_${this.userId}`,
      updatedAt,
      { displayName, bio },
      () => { profile.undelivered = true; },
    );
  }

  async flushOutbox(): Promise<number> {
    this.record('flushOutbox');
    this.checkFailure('flushOutbox');
    let delivered = 0;

    for (const item of this.messages.values()) {
      if (!item.undelivered) continue;
      if (!this.canDeliverTo([item.peerUserId])) continue;
      item.undelivered = false;
      this.__sent.push({
        recipientUserIds: [item.peerUserId],
        modelKey: item.kind === 'pix' ? 'pix' : 'directMessage',
        entryId: item.id,
        sentAt: item.sentAt,
        payload: item.kind === 'pix'
          ? {
              peerUserId: item.peerUserId,
              mediaRef: item.mediaRef,
              contentKey: item.contentKey,
              nonce: item.nonce,
              mediaType: item.mediaType,
              caption: item.caption,
              captionMeta: item.captionMeta,
              displayDuration: item.displayDuration,
            }
          : { peerUserId: item.peerUserId, content: item.content },
      });
      delivered += 1;
    }

    for (const [entryId, rec] of this.undeliveredReceipts) {
      if (!this.canDeliverTo([rec.peerUserId])) continue;
      this.undeliveredReceipts.delete(entryId);
      this.__sent.push({
        recipientUserIds: [rec.peerUserId],
        modelKey: 'seen',
        entryId: rec.receiptId,
        sentAt: rec.viewedAt,
        payload: { entryId, viewedAt: rec.viewedAt },
      });
      delivered += 1;
    }

    for (const story of this.stories.values()) {
      if (!story.undelivered) continue;
      const recipients = this.acceptedFriendIds();
      if (!this.canDeliverTo(recipients)) continue;
      story.undelivered = false;
      this.__sent.push({
        recipientUserIds: recipients,
        modelKey: 'story',
        entryId: story.id,
        sentAt: story.sentAt,
        payload: {
          content: story.content,
          mediaRef: story.mediaRef,
          contentKey: story.contentKey,
          nonce: story.nonce,
          mediaType: story.mediaType,
          captionMeta: story.captionMeta,
        },
      });
      delivered += 1;
    }

    for (const profile of this.profiles.values()) {
      if (!profile.undelivered) continue;
      const recipients = this.acceptedFriendIds();
      if (!this.canDeliverTo(recipients)) continue;
      profile.undelivered = false;
      this.__sent.push({
        recipientUserIds: recipients,
        modelKey: 'profile',
        entryId: `profile_${profile.userId}`,
        sentAt: profile.updatedAt,
        payload: { displayName: profile.displayName, bio: profile.bio },
      });
      delivered += 1;
    }

    return delivered;
  }

  async sweepExpired(): Promise<string[]> {
    this.record('sweepExpired');
    this.checkFailure('sweepExpired');
    const touched = new Set<string>();

    for (const item of this.messages.values()) {
      const ceiling = item.sentAt + MAX_AGE_MS;
      const deadline = item.viewedAt === null ? ceiling : Math.min(ceiling, item.viewedAt + EXPIRE_AFTER_MS);
      if (deadline <= this.clock) {
        if (item.mediaRef !== null) this.__purged.push(item.mediaRef);
        this.tombstones.set(item.id, this.clock);
        this.messages.delete(item.id);
        this.undeliveredReceipts.delete(item.id);
        touched.add(item.kind === 'pix' ? 'pix' : 'directMessage');
      }
    }

    for (const story of this.stories.values()) {
      if (story.sentAt + STORY_MAX_AGE_MS <= this.clock) {
        if (story.mediaRef !== null) this.__purged.push(story.mediaRef);
        this.tombstones.set(story.id, this.clock);
        this.stories.delete(story.id);
        touched.add('story');
      }
    }

    for (const [entryId, rec] of this.pendingReceipts) {
      if (rec.sentAt + MAX_AGE_MS <= this.clock) {
        this.pendingReceipts.delete(entryId);
      }
    }

    for (const [id, erasedAt] of this.tombstones) {
      if (erasedAt + MAX_AGE_MS <= this.clock) {
        this.tombstones.delete(id);
      }
    }

    return [...touched];
  }

  // ─── Test controls (not part of the native surface) ───

  /** Emit a raw event exactly as the native side would. */
  __emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event);
  }

  /** Advance the fake clock by `ms` milliseconds. */
  __advanceTime(ms: number): number {
    this.clock += ms;
    return this.clock;
  }

  /** Current fake clock value. */
  __now(): number {
    return this.clock;
  }

  /** Deliver an incoming direct message and emit `messageReceived`. */
  __deliverMessage(input: {
    id?: string;
    peerUserId?: string;
    authorUserId?: string;
    sentAt?: number;
    viewedAt?: number | null;
    content?: string;
  } = {}): ConversationItem {
    const sentAt = input.sentAt ?? this.nextTimestamp();
    const id = input.id ?? `dm_${sentAt}`;
    const authorUserId = input.authorUserId ?? input.peerUserId ?? 'user_peer';
    const peerUserId = input.peerUserId ?? (authorUserId === this.userId ? 'user_peer' : authorUserId);
    const pending = this.pendingReceipts.get(id);
    const viewedAt = input.viewedAt !== undefined
      ? input.viewedAt
      : pending && pending.senderUserId !== authorUserId
      ? pending.viewedAt
      : null;

    const item: StoredConversationItem = {
      id,
      peerUserId,
      kind: 'message',
      authorUserId,
      sentAt,
      viewedAt,
      content: input.content ?? 'hello',
      mediaRef: null,
      contentKey: null,
      nonce: null,
      mediaType: null,
      caption: null,
      captionMeta: null,
      displayDuration: 0,
      undelivered: false,
    };

    if (!this.tombstones.has(id) && !this.messages.has(id)) {
      this.messages.set(id, item);
      if (viewedAt !== null) this.pendingReceipts.delete(id);
    }

    const stored = this.messages.get(id) ?? item;
    this.__emit({ type: 'messageReceived', model: 'directMessage' });
    return stripUndelivered(stored);
  }

  /** Deliver an incoming pix and emit `messageReceived`. */
  __deliverPix(input: {
    id?: string;
    peerUserId?: string;
    authorUserId?: string;
    sentAt?: number;
    viewedAt?: number | null;
    mediaRef?: string;
    contentKey?: string;
    nonce?: string;
    mediaType?: string | null;
    caption?: string | null;
    captionMeta?: string | null;
    displayDuration?: number;
  } = {}): ConversationItem {
    const sentAt = input.sentAt ?? this.nextTimestamp();
    const id = input.id ?? `pix_${sentAt}`;
    const authorUserId = input.authorUserId ?? input.peerUserId ?? 'user_peer';
    const peerUserId = input.peerUserId ?? (authorUserId === this.userId ? 'user_peer' : authorUserId);
    const pending = this.pendingReceipts.get(id);
    const viewedAt = input.viewedAt !== undefined
      ? input.viewedAt
      : pending && pending.senderUserId !== authorUserId
      ? pending.viewedAt
      : null;

    const item: StoredConversationItem = {
      id,
      peerUserId,
      kind: 'pix',
      authorUserId,
      sentAt,
      viewedAt,
      content: '',
      mediaRef: input.mediaRef ?? 'att_1',
      contentKey: input.contentKey ?? 'key',
      nonce: input.nonce ?? 'nonce',
      mediaType: input.mediaType ?? 'photo',
      caption: input.caption ?? null,
      captionMeta: input.captionMeta ?? null,
      displayDuration: input.displayDuration ?? 5,
      undelivered: false,
    };

    if (!this.tombstones.has(id) && !this.messages.has(id)) {
      this.messages.set(id, item);
      if (viewedAt !== null) this.pendingReceipts.delete(id);
    }

    const stored = this.messages.get(id) ?? item;
    this.__emit({ type: 'messageReceived', model: 'pix' });
    return stripUndelivered(stored);
  }

  /** Deliver an incoming seen receipt and emit `messageReceived`. */
  __deliverSeen(
    input: string | {
      entryId: string;
      senderUserId?: string;
      viewedAt?: number;
      sentAt?: number;
    },
    viewedAtArg?: number,
  ): void {
    const opts = typeof input === 'string' ? { entryId: input, viewedAt: viewedAtArg } : input;
    const item = this.messages.get(opts.entryId);
    const sentAt = opts.sentAt ?? opts.viewedAt ?? this.nextTimestamp();
    const rawViewedAt = opts.viewedAt ?? sentAt;
    const effectiveViewedAt = Math.min(rawViewedAt, sentAt);
    const senderUserId = opts.senderUserId ?? (item ? item.peerUserId : 'user_peer');

    if (item) {
      if (senderUserId !== item.authorUserId && item.viewedAt === null) {
        item.viewedAt = effectiveViewedAt;
      }
    } else if (!this.tombstones.has(opts.entryId) && !this.pendingReceipts.has(opts.entryId)) {
      this.pendingReceipts.set(opts.entryId, { senderUserId, viewedAt: effectiveViewedAt, sentAt });
    }
    this.__emit({ type: 'messageReceived', model: 'seen' });
  }

  /** Deliver an incoming story and emit `messageReceived`. */
  __deliverStory(input: {
    id?: string;
    authorUserId?: string;
    sentAt?: number;
    content?: string;
    mediaRef?: string | null;
    contentKey?: string | null;
    nonce?: string | null;
    mediaType?: string | null;
    captionMeta?: string | null;
  } = {}): StoryItem {
    const sentAt = input.sentAt ?? this.nextTimestamp();
    const id = input.id ?? `story_${sentAt}`;
    const story: StoredStoryItem = {
      id,
      authorUserId: input.authorUserId ?? 'user_peer',
      sentAt,
      content: input.content ?? '',
      mediaRef: input.mediaRef ?? null,
      contentKey: input.contentKey ?? null,
      nonce: input.nonce ?? null,
      mediaType: input.mediaType ?? null,
      captionMeta: input.captionMeta ?? null,
      undelivered: false,
    };

    if (!this.tombstones.has(id) && !this.stories.has(id)) {
      this.stories.set(id, story);
    }

    const stored = this.stories.get(id) ?? story;
    this.__emit({ type: 'messageReceived', model: 'story' });
    return stripUndelivered(stored);
  }

  /** Deliver an incoming profile update (`REPLACE` by `(updatedAt, authorDeviceId)`) and emit `messageReceived`. */
  __deliverProfile(input: {
    userId: string;
    authorDeviceId?: string;
    updatedAt?: number;
    displayName: string;
    bio?: string;
  }): ProfileItem {
    const updatedAt = input.updatedAt ?? this.nextTimestamp();
    const authorDeviceId = input.authorDeviceId ?? 'device_peer';
    const incoming: StoredProfileItem = {
      userId: input.userId,
      authorDeviceId,
      updatedAt,
      displayName: input.displayName,
      bio: input.bio ?? '',
      undelivered: false,
    };

    const existing = this.profiles.get(input.userId);
    const wins = !existing || (
      incoming.updatedAt !== existing.updatedAt
        ? incoming.updatedAt > existing.updatedAt
        : incoming.authorDeviceId > existing.authorDeviceId
    );
    if (wins) {
      this.profiles.set(input.userId, incoming);
    }

    const stored = this.profiles.get(input.userId)!;
    this.__emit({ type: 'messageReceived', model: 'profile' });
    return stripUndelivered(stored);
  }

  /** An authenticated session; without one, `getUserId()` is null. */
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
    this.messages.clear();
    this.stories.clear();
    this.profiles.clear();
    this.tombstones.clear();
    this.pendingReceipts.clear();
    this.undeliveredReceipts.clear();
    this.__sent.length = 0;
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

  /** Throw before storing unless the injected failure is `SEND_FAILED` (which happens after storing). */
  private checkPreStoreFailure(method: string): void {
    const f = this.failures.get(method);
    if (!f || f.code === 'SEND_FAILED') return;
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

  async resetAccount(username: string, _password: string): Promise<void> {
    this.record('resetAccount');
    this.checkFailure('resetAccount');
    this.clearLocalState();
    this.username = username;
    this.primary = true;
    this.__setAuthState('authenticated');
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
    this.messages.clear();
    this.stories.clear();
    this.profiles.clear();
    this.tombstones.clear();
    this.pendingReceipts.clear();
    this.undeliveredReceipts.clear();
    this.__sent.length = 0;
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

  /** Accepts the codes `beginLink` issues, named after `FAKE_LINK_DEVICE_NAME`. */
  async linkCodeDeviceName(code: string): Promise<string> {
    this.record('linkCodeDeviceName');
    this.checkFailure('linkCodeDeviceName');
    if (!code.startsWith('link_')) throw rejection('INVALID_ARGUMENT', 'Invalid link code');
    return FAKE_LINK_DEVICE_NAME;
  }

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

export const FAKE_LINK_DEVICE_NAME = 'Test phone';

function stripUndelivered<T extends { undelivered: boolean }>({
  undelivered: _undelivered,
  ...rest
}: T): Omit<T, 'undelivered'> {
  return rest;
}

/** A rejection as the native side delivers it: an `Error` with a `code`. */
function rejection(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
