import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  Obscura, onObscuraEvent,
  type Friend, type ConnectionState, type ObscuraEvent,
} from '../native/ObscuraModule';
import { drainInboxFully } from './drainInbox';
import { writeEntry, flushOutbox } from './writeEntry';
import { requestStartupPermissions } from '../application/requestStartupPermissions';
import { logError } from '../utils/log';
import type { Entry } from '../domain/merge';
import type { ModelData, ModelName } from '../models/schema';
import { EPHEMERAL_MODELS, isEphemeral } from '../domain/expiry';
import { SEEN_MODEL, indexReceipts, seenEntryId, viewedAtFor } from '../domain/seen';
import { readEntries } from './entryStore';
import { sweepExpired } from './expiry';

/** An entry as screens see it: `data` as sent, plus when its recipient saw it (ephemeral models). */
export type ScreenEntry<D = Record<string, unknown>> = Entry<D> & { viewedAt: number | null };



/**
 * Process-wide store for session state and application entry caches.
 *
 * Selectors:
 *   - useSession()           — session shape used by every screen
 *   - useModelEntries(model) — auto-refreshing entries for a single model
 *
 * Side effects (event subscription, inbox drain, push permission) live in
 * useObscuraBootstrap which is mounted once at the App root.
 */

interface ObscuraStore {
  // Session
  /**
   * Has the initial cold-start auth check completed? Until this is true,
   * `authed` should not be trusted — RootNavigator shows a splash screen
   * to avoid flashing the AuthScreen for users who are already logged in.
   */
  bootstrapped: boolean;
  authed: boolean;
  myUserId: string;
  myUsername: string;
  myDeviceId: string;
  friends: Friend[];
  pending: Friend[];
  connState: ConnectionState;

  // Per-model entries cache. A `undefined` slot means "never loaded";
  // first useModelEntries(model) triggers the fetch + creates the slot,
  // after which bootstrap keeps it fresh on events.
  entries: Record<string, ScreenEntry[] | undefined>;

  // Actions — public
  setAuthed: (v: boolean) => void;
  logout: () => Promise<void>;
  reset: () => void;

  // Actions — internal (called from bootstrap; the underscore prefix is a
  // convention meaning "don't call from screens").
  _setBootstrapped: (v: boolean) => void;
  _setUserId: (id: string) => void;
  _setUsername: (name: string) => void;
  _setDeviceId: (id: string) => void;
  _setFriendsAndPending: (friends: Friend[], pending: Friend[]) => void;
  _setConnState: (s: ConnectionState) => void;
  _setEntries: (model: string, entries: ScreenEntry[]) => void;
}

/** Everything a session holds, as it is with nobody signed in. */
const SIGNED_OUT = {
  authed: false,
  myUserId: '',
  myUsername: '',
  myDeviceId: '',
  friends: [],
  pending: [],
  connState: 'disconnected',
  entries: {},
} as const satisfies Partial<ObscuraStore>;

export const useStore = create<ObscuraStore>((set, get) => ({
  bootstrapped: false,
  ...SIGNED_OUT,

  setAuthed: (v) => set({ authed: v }),

  logout: async () => {
    try { await Obscura.logout(); } catch (e) { logError('logout', e); }
    get().reset();
  },

  reset: () => set(SIGNED_OUT),

  _setBootstrapped: (v) => set({ bootstrapped: v }),
  _setUserId: (id) => set({ myUserId: id }),
  _setUsername: (name) => set({ myUsername: name }),
  _setDeviceId: (id) => set({ myDeviceId: id }),
  _setFriendsAndPending: (friends, pending) => set({ friends, pending }),
  _setConnState: (s) => set({ connState: s }),
  _setEntries: (model, entries) => set((state) => ({
    entries: { ...state.entries, [model]: entries },
  })),
}));

// ─── Selectors ───────────────────────────────────────────

/**
 * Session shape. Returns a stable object via shallow equality so re-renders
 * only fire when one of the selected fields changes.
 */
export function useSession() {
  return useStore(useShallow((s) => ({
    authed: s.authed,
    myUserId: s.myUserId,
    myUsername: s.myUsername,
    myDeviceId: s.myDeviceId,
    friends: s.friends,
    pending: s.pending,
    connState: s.connState,
    setAuthed: s.setAuthed,
    logout: s.logout,
  })));
}

/**
 * All entries for `model`, loading on first use; bootstrap keeps them fresh. Every write and every
 * received entry is validated against the schema, which is what makes the typed `data` sound.
 */
export function useModelEntries<M extends ModelName>(model: M): ScreenEntry<ModelData<M>>[] {
  const entries = useStore((s) => s.entries[model]);
  useEffect(() => {
    if (entries !== undefined) return;
    loadEntries(model);
  }, [model, entries]);
  return (entries ?? []) as unknown as ScreenEntry<ModelData<M>>[];
}

export async function loadEntries(model: string): Promise<void> {
  try {
    const rows = await readEntries(model);
    const receipts = indexReceipts(isEphemeral(model) ? await readEntries(SEEN_MODEL) : []);
    useStore.getState()._setEntries(model, rows.map(({ undelivered: _undelivered, ...entry }) => (
      { ...entry, viewedAt: viewedAtFor(model, entry, receipts) }
    )));
  } catch (e) {
    logError('entries.load:' + model, e);
  }
}

/** Reload the given models a screen has loaded. A receipt change re-renders the entries it marks. */
async function refreshLoaded(models: Iterable<string>): Promise<void> {
  const changed = new Set(models);
  if (changed.has(SEEN_MODEL)) EPHEMERAL_MODELS.forEach((m) => changed.add(m));
  const loaded = useStore.getState().entries;
  for (const model of changed) {
    // A model nobody has opened does not need to be in memory.
    if (loaded[model] !== undefined) {
      await loadEntries(model).catch((e) => logError('entries.refresh:' + model, e));
    }
  }
}

/**
 * Drain the inbox and refresh whatever it changed.
 *
 * **Every trigger goes through here**, because a drain that only happens on one of them is how
 * messages get stranded — see the triggers wired in `ObscuraBootstrap`.
 */
export async function drainAndRefresh(): Promise<void> {
  try {
    await refreshLoaded((await drainInboxFully()).touched);
  } catch (e) {
    logError('inbox.drain', e);
  }
}

/**
 * Store an entry and send it to its audience, then refresh the model so the screen shows it.
 *
 * This is the single application write path. It exists at store level rather
 * than as a bare `writeEntry` call because the audience needs the
 * session — who I am, which device, who my friends are — and threading three fields through every
 * screen would invite one of them being passed wrong.
 *
 * The refresh is explicit because `entryPut` is a plain write and emits no event.
 *
 * Throws `DirectRoutingUnresolved` when the audience cannot be resolved — nothing is stored or sent.
 * Callers should surface that: it means the entry reached nobody.
 */
export async function saveEntry(
  model: string,
  data: Record<string, unknown>,
  id?: string,
): Promise<string> {
  const s = useStore.getState();

  // The session loads asynchronously after `authed` flips, and a write in that window is quietly
  // wrong rather than failing: an empty `authorDeviceId` sorts LOWEST, so it loses every REPLACE
  // tie-break on every device (DOMAIN_CONTRACT), and an empty `selfUserId` disables the self-filter in
  // `resolveAudience`. Both are invisible — the entry stores and sends, it just never wins and may
  // name the author as a recipient. Refuse instead.
  if (s.myUserId === '' || s.myDeviceId === '') {
    throw new Error('saveEntry called before the session identity loaded — refusing to write');
  }

  try {
    return await writeEntry({
      model,
      id,
      data,
      selfUserId: s.myUserId,
      myDeviceId: s.myDeviceId,
      // `s.friends` is already the accepted set; `resolveAudience` re-checks status anyway, because a
      // resolver that trusts its caller to have filtered is one refactor away from a leak.
      friends: s.friends,
    });
  } finally {
    // `finally`, not "after the await". `writeEntry` deliberately KEEPS the local row and rethrows
    // when a send reaches nobody, so the refresh must also run on that path.
    //
    // An unresolvable audience throws before anything is stored, so refreshing then is a no-op read
    // rather than a wrong one.
    await refreshLoaded([model]);
  }
}

/**
 * Retry entries whose send reached nobody.
 *
 * The counterpart to `drainAndRefresh`, on the same triggers. It does not refresh the UI: the mark
 * it clears is delivery bookkeeping that nothing renders.
 */
export async function flushOutboxFromStore(): Promise<void> {
  const s = useStore.getState();
  if (s.myUserId === '') return; // pre-identity; the next trigger will catch it
  try {
    await flushOutbox({ selfUserId: s.myUserId, friends: s.friends });
  } catch (e) {
    logError('outbox.flush', e);
  }
}

// ─── Bootstrap ───────────────────────────────────────────

/**
 * Drain the inbox and flush the outbox — the pair of things a "the network moved" signal means.
 *
 * They are always triggered together so the receive and retry paths respond to
 * the same connectivity and lifecycle signals.
 */
function syncBothWays(label: string): void {
  drainAndRefresh().catch((e) => logError('entries.drain:' + label, e));
  flushOutboxFromStore().catch((e) => logError('outbox.flush:' + label, e));
  sweepAndRefresh().catch((e) => logError('expiry.sweep:' + label, e));
}

/** Ephemeral entries expire on a clock, so the sweep also runs on this interval while signed in. */
const SWEEP_INTERVAL_MS = 30 * 1000;

export async function sweepAndRefresh(): Promise<void> {
  await refreshLoaded(await sweepExpired());
}

/** Send a seen receipt for an entry the user has just seen. The caller checks they are its recipient. */
export async function markSeen(model: string, entry: Entry): Promise<void> {
  const conversationId = entry.data.conversationId;
  if (typeof conversationId !== 'string') return;
  await saveEntry(SEEN_MODEL, { conversationId, viewedAt: Date.now() }, seenEntryId(model, entry.id));
}

/**
 * Apply one native event to the store.
 *
 * Extracted from the `ObscuraBootstrap` hook so it can be driven directly by a test: every drain
 * trigger in the app is a branch of this switch, and inside a hook none of them were reachable
 * without a React renderer this repo does not depend on. The hook below is now only the
 * subscription.
 */
export function applyObscuraEvent(event: ObscuraEvent): void {
  const s = useStore.getState();
  switch (event.type) {
    case 'friendsChanged': {
      refreshFriendGraph().catch((e) => logError('friends.refresh', e));
      return;
    }
    case 'connectionChanged':
      s._setConnState(event.state);
      // Reconnecting is when the server redelivers anything it did not see acked, so it is one
      // of the moments the inbox is most likely to have grown.
      if (event.state === 'connected') syncBothWays('connected');
      return;
    case 'authStateChanged':
      if (event.state === 'loggedOut') s.reset();
      else s.setAuthed(true);
      return;

    case 'appStateChanged':
      // Native background processing may persist messages while the JS runtime
      // is suspended, so foregrounding must drain again.
      if (event.state === 'active') syncBothWays('foreground');
      return;
    case 'pushTokenReceived':
      Obscura.registerPushToken(event.token).catch((e) => logError('push.register', e));
      return;
    case 'messageReceived': {
      // DRAIN FIRST, then refresh. The event is only a wake-up — under the thin kit the data is
      // in the inbox, not in the event, and nothing reaches the entry store until the app moves
      // it there. Refreshing without draining would show a store that has not changed.
      drainAndRefresh().catch((e) => logError('entries.drain:' + event.model, e));
      return;
    }
  }
}

export async function refreshFriendGraph(): Promise<void> {
  const all = await Obscura.getFriends();
  const list = all || [];
  useStore.getState()._setFriendsAndPending(
    list.filter((f) => f.status === 'accepted'),
    list.filter((f) => f.status !== 'accepted'),
  );
}

/**
 * Pull the session identity and graph, then run the cold-start sync.
 *
 * Extracted from the `[authed]` effect for the same reason as `applyObscuraEvent`: the cold-start
 * drain is the trigger whose absence stranded messages, and it was unreachable from a test.
 */
export async function loadSession(): Promise<void> {
  // `obscuraSchema` stays in the app: `drainInbox` reads its merge and
  // authorization rules, and `writeEntry` reads its audience (DOMAIN_CONTRACT).
  const store = useStore.getState();
  await Promise.all([
    Obscura.getUserId()
      .then((id) => store._setUserId(id || ''))
      .catch((e) => logError('bootstrap.userId', e)),
    Obscura.getUsername()
      .then((name) => store._setUsername(name || ''))
      .catch((e) => logError('bootstrap.username', e)),
    Obscura.getDeviceId()
      .then((id) => store._setDeviceId(id || ''))
      .catch((e) => logError('bootstrap.deviceId', e)),
    refreshFriendGraph().catch((e) => logError('bootstrap.friends', e)),
    Obscura.getConnectionState()
      .then((cs) => store._setConnState(cs || 'disconnected'))
      .catch((e) => logError('bootstrap.conn', e)),
  ]);

  // Android push can persist and ack rows with no JS runtime, and `messageReceived` may be dropped,
  // so cold start drains independently of the event.
  //
  // Awaited on the identity pulls above, not fired alongside them: the drain needs `getUserId()` to
  // authorize what it stores, and the outbox flush reads the identity out of the store.
  syncBothWays('coldStart');
}

/**
 * Mount this once at the app root. Wires every native event to a store
 * update, gates the initial state pulls behind `authed`,
 * and requests push permission once per session after first connect.
 *
 * The hook returns null so it can be rendered as a component:
 *   <ObscuraBootstrap />
 */
export function ObscuraBootstrap(): null {
  // Cold-start auth check — runs once. The `bootstrapped` flag flips true
  // in `finally` regardless of result, which the navigator uses to stop
  // showing the splash screen.
  useEffect(() => {
    Obscura.getAuthState()
      .then((state) => {
        if (state === 'authenticated') useStore.getState().setAuthed(true);
      })
      .catch((e) => logError('bootstrap.authState', e))
      .finally(() => {
        useStore.getState()._setBootstrapped(true);
      });
  }, []);

  // Single global event subscription.
  useEffect(() => onObscuraEvent(applyObscuraEvent), []);

  // When authed flips true, pull initial session state and run the cold-start sync.
  const authed = useStore((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    loadSession().catch((e) => logError('bootstrap.session', e));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const timer = setInterval(() => {
      sweepAndRefresh().catch((e) => logError('expiry.sweep:timer', e));
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authed]);

  // Permission prompts must be serialized. Android drops concurrent requests, which previously
  // left the camera at "not determined" when microphone/push prompts raced it after login.
  const connState = useStore((s) => s.connState);
  const permissionsRequestedRef = useRef(false);
  useEffect(() => {
    if (!authed) { permissionsRequestedRef.current = false; return; }
    if (connState !== 'connected') return;
    if (permissionsRequestedRef.current) return;
    permissionsRequestedRef.current = true;
    requestStartupPermissions().catch((e: unknown) => {
      console.warn('[permissions] startup request failed:', e);
    });
  }, [authed, connState]);

  return null;
}
