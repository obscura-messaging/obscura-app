import { useEffect, useMemo, useRef } from 'react';
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
import { acceptedFriends, pendingFriends, type Identity } from '../domain/friends';
import { SEEN_MODEL, indexReceipts, seenEntryId, viewedAtFor } from '../domain/seen';
import { readEntries } from './entryStore';
import { sweepExpired } from './expiry';

/** An entry as screens see it: `data` as sent, plus when its recipient saw it (ephemeral models). */
export type ScreenEntry<D = Record<string, unknown>> = Entry<D> & { viewedAt: number | null };

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
  entries: Record<string, ScreenEntry[] | undefined>;
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

export function resetSession(): void {
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
  return (entries ?? []) as unknown as ScreenEntry<ModelData<M>>[];
}

// ─── Entry cache ─────────────────────────────────────────

export async function loadEntries(model: string): Promise<void> {
  try {
    const rows = await readEntries(model);
    const receipts = indexReceipts(isEphemeral(model) ? await readEntries(SEEN_MODEL) : []);
    const entries = rows.map(({ undelivered: _undelivered, ...entry }) => (
      { ...entry, viewedAt: viewedAtFor(model, entry, receipts) }
    ));
    useStore.setState((s) => ({ entries: { ...s.entries, [model]: entries } }));
  } catch (e) {
    logError('entries.load:' + model, e);
  }
}

/** Reload the changed models that a screen has loaded. A receipt change reloads what it marks. */
async function refreshLoaded(models: Iterable<string>): Promise<void> {
  const changed = new Set(models);
  if (changed.has(SEEN_MODEL)) EPHEMERAL_MODELS.forEach((m) => changed.add(m));
  for (const model of changed) {
    if (useStore.getState().entries[model] !== undefined) await loadEntries(model);
  }
}

// ─── Sync ────────────────────────────────────────────────
// These never reject: they run from event handlers and timers that cannot act on a failure.

export async function drainAndRefresh(): Promise<void> {
  try {
    await refreshLoaded((await drainInboxFully()).touched);
  } catch (e) {
    logError('inbox.drain', e);
  }
}

/** Retry entries whose send reached nobody. */
export async function flushOutboxFromStore(): Promise<void> {
  const { myUserId, friends } = useStore.getState();
  if (myUserId === '') return;
  try {
    await flushOutbox({ selfUserId: myUserId, friends });
  } catch (e) {
    logError('outbox.flush', e);
  }
}

export async function sweepAndRefresh(): Promise<void> {
  await refreshLoaded(await sweepExpired());
}

/** Everything "the network or the app came back" means: receive, retry and expire. */
function syncAll(): void {
  drainAndRefresh();
  flushOutboxFromStore();
  sweepAndRefresh();
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

// ─── Session ─────────────────────────────────────────────

export async function refreshFriends(): Promise<void> {
  useStore.setState({ friends: await Obscura.getFriends() });
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
      // Native code may have stored rows while JS was suspended.
      if (event.state === 'active') syncAll();
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

/** Load the session identity and friends, then sync: the drain needs the identity to authorize. */
export async function loadSession(): Promise<void> {
  const set = (state: Partial<Session>) => useStore.setState(state);
  await Promise.all([
    Obscura.getUserId().then((id) => set({ myUserId: id ?? '' })),
    Obscura.getUsername().then((name) => set({ myUsername: name ?? '' })),
    Obscura.getDeviceId().then((id) => set({ myDeviceId: id ?? '' })),
    Obscura.isPrimary().then((isPrimary) => set({ isPrimary })),
    Obscura.getConnectionState().then((connState) => set({ connState })),
    refreshFriends(),
  ].map((pull) => pull.catch((e) => logError('session.load', e))));
  // Push can store rows with no JS running and `messageReceived` may be dropped, so cold start syncs.
  syncAll();
}

/** Mounted once at the app root: the auth check, the event subscription and the signed-in loops. */
export function ObscuraBootstrap(): null {
  useEffect(() => {
    Obscura.getAuthState()
      .then((state) => { if (state === 'authenticated') useStore.setState({ authed: true }); })
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
