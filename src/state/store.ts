import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  Obscura, onObscuraEvent,
  type Friend, type ConnectionState, type ObscuraEvent,
} from '../native/ObscuraModule';
import { drainInboxFully } from './drainInbox';
import { writeEntry, flushOutbox } from './writeEntry';
import { primaryOnly } from './devices';
import { requestStartupPermissions } from './permissions';
import { getJsLog, logError } from '../utils/log';
import type { Entry } from '../domain/merge';
import type { ModelData, ModelName } from '../models/schema';
import { EPHEMERAL_MODELS, isEphemeral } from '../domain/expiry';
import { acceptedFriends, pendingFriends, type Identity } from '../domain/friends';
import { cleanCode } from '../domain/qr';
import { SEEN_MODEL, indexReceipts, seenEntryId, viewedAtFor } from '../domain/seen';
import { readEntries } from './entryStore';
import { sweepExpired } from './expiry';

export type { Friend, ConnectionState };

/** An entry as screens see it: `data` as sent, plus when its recipient saw it (ephemeral models). */
export type ScreenEntry<D = Record<string, unknown>> = Entry<D> & { viewedAt: number | null };

type ModelEntryMap = {
  [M in ModelName]?: ScreenEntry<ModelData<M>>[];
} & Record<string, ScreenEntry[] | undefined>;

interface Session {
  /** The cold-start auth check has finished, so `authed` can be trusted. */
  bootstrapped: boolean;
  authed: boolean;
  myUserId: string;
  myUsername: string;
  myDeviceId: string;
  /** Whether this device is the account's primary; null until the session loads. */
  isPrimary: boolean | null;
  /** Every relationship, any status. */
  friends: Friend[];
  connState: ConnectionState;
  /** Entries per model; `undefined` until a screen first reads the model. */
  entries: ModelEntryMap;
}

const SIGNED_OUT = {
  authed: false,
  myUserId: '',
  myUsername: '',
  myDeviceId: '',
  isPrimary: null,
  friends: [],
  connState: 'disconnected',
  entries: {},
} as const satisfies Omit<Session, 'bootstrapped'>;

export const useStore = create<Session>(() => ({ bootstrapped: false, ...SIGNED_OUT }));

/** Models a screen has requested, tracked before the first async read finishes so concurrent refreshes are not dropped. */
const openedModels = new Set<string>();
/** In-memory index of `seen` receipts, so receipt updates can re-project `viewedAt` without re-reading ephemeral tables. */
let cachedReceipts: ReadonlyMap<string, Entry> | null = null;
/** Incremented on every `resetSession()` so in-flight reads from a signed-out session never write into the next one. */
let sessionEpoch = 0;

export function resetSession(): void {
  sessionEpoch += 1;
  openedModels.clear();
  cachedReceipts = null;
  useStore.setState(SIGNED_OUT);
}

/** Signs out locally even when the kit call fails. */
export async function logout(): Promise<void> {
  try { await Obscura.logout(); } catch (e) { logError('logout', e); }
  resetSession();
}

// ─── Selectors ───────────────────────────────────────────

export function useSession() {
  return useStore(useShallow((s) => ({
    authed: s.authed,
    myUserId: s.myUserId,
    myUsername: s.myUsername,
    isPrimary: s.isPrimary,
    connState: s.connState,
  })));
}

export function useIdentity(): Identity {
  return useStore(useShallow((s) => ({ myUserId: s.myUserId, myUsername: s.myUsername, friends: s.friends })));
}

export function useAcceptedFriends(): Friend[] {
  const friends = useStore((s) => s.friends);
  return useMemo(() => acceptedFriends(friends), [friends]);
}

export function usePendingFriends(): Friend[] {
  const friends = useStore((s) => s.friends);
  return useMemo(() => pendingFriends(friends), [friends]);
}

/**
 * All entries for `model`, loading on first use. Every stored entry passed the schema's field check,
 * which is what makes the typed `data` sound.
 */
export function useModelEntries<M extends ModelName>(model: M): ScreenEntry<ModelData<M>>[] {
  const entries = useStore((s) => s.entries[model]);
  useEffect(() => {
    if (entries === undefined) loadEntries(model);
  }, [model, entries]);
  return (entries ?? []) as ScreenEntry<ModelData<M>>[];
}

// ─── Entry cache ─────────────────────────────────────────

async function loadReceipts(reload = false): Promise<ReadonlyMap<string, Entry>> {
  if (cachedReceipts === null || reload) {
    const epoch = sessionEpoch;
    const rows = indexReceipts(await readEntries(SEEN_MODEL));
    if (epoch !== sessionEpoch) return rows;
    cachedReceipts = rows;
  }
  return cachedReceipts;
}

export async function loadEntries(model: string, preloadedReceipts?: ReadonlyMap<string, Entry>): Promise<void> {
  const epoch = sessionEpoch;
  openedModels.add(model);
  try {
    const rows = await readEntries(model);
    const receipts = isEphemeral(model)
      ? (preloadedReceipts ?? await loadReceipts(true))
      : new Map<string, Entry>();
    if (epoch !== sessionEpoch) return;
    const entries = rows.map(({ undelivered: _undelivered, ...entry }) => (
      { ...entry, viewedAt: viewedAtFor(model, entry, receipts) }
    ));
    useStore.setState((s) => ({ entries: { ...s.entries, [model]: entries } }));
  } catch (e) {
    logError('entries.load:' + model, e);
  }
}

/** Reload the changed models that a screen has loaded. A receipt-only change re-projects `viewedAt` in memory. */
async function refreshLoaded(models: Iterable<string>): Promise<void> {
  const epoch = sessionEpoch;
  const changed = new Set(models);
  const seenChanged = changed.delete(SEEN_MODEL);
  const isOpened = (m: string) => openedModels.has(m) || useStore.getState().entries[m] !== undefined;
  const toReload = [...changed].filter(isOpened);

  const needsReceipts = seenChanged || toReload.some(isEphemeral);
  const receipts = needsReceipts ? await loadReceipts(seenChanged) : undefined;
  if (epoch !== sessionEpoch) return;

  for (const model of toReload) {
    await loadEntries(model, receipts);
    if (epoch !== sessionEpoch) return;
  }

  if (seenChanged && receipts) {
    const toReproject = EPHEMERAL_MODELS.filter(
      (m) => !changed.has(m) && useStore.getState().entries[m] !== undefined,
    );
    if (toReproject.length > 0) {
      useStore.setState((s) => {
        const next: Record<string, ScreenEntry[] | undefined> = { ...s.entries };
        for (const m of toReproject) {
          const current = s.entries[m];
          if (current) {
            next[m] = current.map((e) => ({ ...e, viewedAt: viewedAtFor(m, e, receipts) }));
          }
        }
        return { entries: next as ModelEntryMap };
      });
    }
  }
}

// ─── Sync ────────────────────────────────────────────────
// These never reject: they run from event handlers and timers that cannot act on a failure.

/** Coalesce concurrent triggers within the same session epoch into at most one in-flight execution plus one trailing pass. */
function coalesce(task: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let inFlightEpoch = -1;
  let rerun = false;
  return () => {
    if (inFlight !== null && inFlightEpoch === sessionEpoch) {
      rerun = true;
      return inFlight;
    }
    const epoch = sessionEpoch;
    inFlightEpoch = epoch;
    rerun = false;
    const p = (async () => {
      do {
        rerun = false;
        await task();
      } while (rerun && epoch === sessionEpoch);
    })().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}

export const drainAndRefresh: () => Promise<void> = coalesce(async () => {
  try {
    await refreshLoaded((await drainInboxFully()).touched);
  } catch (e) {
    logError('inbox.drain', e);
  }
});

/** Retry entries whose send reached nobody. */
export const flushOutboxFromStore: () => Promise<void> = coalesce(async () => {
  const { myUserId, friends } = useStore.getState();
  if (myUserId === '') return;
  try {
    await flushOutbox({ selfUserId: myUserId, friends });
  } catch (e) {
    logError('outbox.flush', e);
  }
});

export const sweepAndRefresh: () => Promise<void> = coalesce(async () => {
  await refreshLoaded(await sweepExpired());
});

/** Everything "the network or the app came back" means: receive, retry and expire. */
async function syncAll(): Promise<void> {
  await Promise.all([
    drainAndRefresh(),
    flushOutboxFromStore(),
    sweepAndRefresh(),
  ]);
}

const SWEEP_INTERVAL_MS = 30 * 1000;

// ─── Writes ──────────────────────────────────────────────

/**
 * Store an entry, send it to its audience and refresh the model. The single application write path.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be resolved (nothing is stored), or the
 *   send error when it reached nobody (the entry is kept and retried by the outbox).
 */
export async function saveEntry(model: string, data: Record<string, unknown>, id?: string): Promise<string> {
  const { myUserId, myDeviceId, friends } = useStore.getState();
  // An empty author device would lose every REPLACE tie-break, so refuse until the session loads.
  if (myUserId === '' || myDeviceId === '') {
    throw new Error('saveEntry called before the session identity loaded — refusing to write');
  }
  try {
    return await writeEntry({ model, id, data, selfUserId: myUserId, myDeviceId, friends });
  } finally {
    await refreshLoaded([model]);
  }
}

/** Send a seen receipt for an entry this user received. */
export async function markSeen(model: string, entry: Entry): Promise<void> {
  const conversationId = entry.data.conversationId;
  if (typeof conversationId !== 'string') return;
  await saveEntry(SEEN_MODEL, { conversationId, viewedAt: Date.now() }, seenEntryId(model, entry.id));
}

// ─── Session & Friends ───────────────────────────────────

export async function refreshFriends(): Promise<void> {
  useStore.setState({ friends: await Obscura.getFriends() });
}

export async function addFriend(rawCode: string): Promise<void> {
  const code = cleanCode('friend', rawCode);
  await primaryOnly(() => Obscura.addFriendByCode(code));
  await refreshFriends();
}

export async function acceptFriend(userId: string): Promise<void> {
  await primaryOnly(() => Obscura.acceptFriend(userId));
  await refreshFriends();
}

export async function removeFriend(userId: string): Promise<void> {
  await primaryOnly(() => Obscura.removeFriend(userId));
  await refreshFriends();
}

export function getFriendCode(): Promise<string> {
  return Obscura.getFriendCode();
}

export function copyToClipboard(text: string): Promise<void> {
  return Obscura.setClipboard(text);
}

export async function loadDebugLog(): Promise<string[]> {
  const native = await Obscura.getDebugLog();
  return [...native, ...getJsLog()];
}

export function subscribeToLaunchScreen(onScreen: (screen: string) => void): () => void {
  Obscura.getLaunchIntent()
    .then((intent) => { if (intent) onScreen(intent.screen); })
    .catch((e) => logError('launchIntent', e));
  return onObscuraEvent((event) => {
    if (event.type === 'launchedFrom') onScreen(event.screen);
  });
}

export function applyObscuraEvent(event: ObscuraEvent): void {
  switch (event.type) {
    case 'friendsChanged':
      refreshFriends().catch((e) => logError('friends.refresh', e));
      return;
    case 'connectionChanged':
      useStore.setState({ connState: event.state });
      // The server redelivers anything unacknowledged on reconnect.
      if (event.state === 'connected') syncAll();
      return;
    case 'authStateChanged':
      if (event.state === 'loggedOut') resetSession();
      else useStore.setState({ authed: true });
      return;
    case 'appStateChanged':
      // Native code may have stored rows while JS was suspended; only flush the outbox if connected.
      if (event.state === 'active') {
        drainAndRefresh();
        if (useStore.getState().connState === 'connected') flushOutboxFromStore();
        sweepAndRefresh();
      }
      return;
    case 'pushTokenReceived':
      Obscura.registerPushToken(event.token).catch((e) => logError('push.register', e));
      return;
    case 'messageReceived':
      // Only a wake-up: the message is in the inbox, not the event.
      drainAndRefresh();
      return;
  }
}

/** Load the session identity and friends atomically, then sync: the drain needs the identity to authorize. */
export async function loadSession(): Promise<void> {
  const pull = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch((e) => { logError('session.load', e); return fallback; });
  const [userId, username, deviceId, isPrimary, connState, friends] = await Promise.all([
    pull(Obscura.getUserId(), null),
    pull(Obscura.getUsername(), null),
    pull(Obscura.getDeviceId(), null),
    pull(Obscura.isPrimary(), null),
    pull(Obscura.getConnectionState(), 'disconnected' as ConnectionState),
    pull(Obscura.getFriends(), [] as Friend[]),
  ]);
  useStore.setState({
    myUserId: userId ?? '',
    myUsername: username ?? '',
    myDeviceId: deviceId ?? '',
    isPrimary,
    connState,
    friends,
  });
  // Push can store rows with no JS running and `messageReceived` may be dropped, so cold start syncs.
  await syncAll();
}

/** Mounted once at the app root: the auth check, the event subscription and the signed-in loops. */
export function ObscuraBootstrap(): null {
  useEffect(() => {
    Obscura.getAuthState()
      .then(async (state) => {
        if (state === 'authenticated') {
          await loadSession();
          useStore.setState({ authed: true });
        }
      })
      .catch((e) => logError('bootstrap.authState', e))
      .finally(() => useStore.setState({ bootstrapped: true }));
  }, []);

  useEffect(() => onObscuraEvent(applyObscuraEvent), []);

  const authed = useStore((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    loadSession();
    const timer = setInterval(() => { sweepAndRefresh(); }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authed]);

  // Once per session, after the first connect. Android drops concurrent permission prompts.
  const connState = useStore((s) => s.connState);
  const permissionsRequested = useRef(false);
  useEffect(() => {
    if (!authed) { permissionsRequested.current = false; return; }
    if (connState !== 'connected' || permissionsRequested.current) return;
    permissionsRequested.current = true;
    requestStartupPermissions().catch((e) => logError('permissions.startup', e));
  }, [authed, connState]);

  return null;
}
