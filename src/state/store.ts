import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import {
  Obscura,
  onObscuraEvent,
  type Friend,
  type ConnectionState,
  type ObscuraEvent,
  type EntryModel,
  type ConversationItem,
  type StoryItem,
  type ProfileItem,
} from '../native/ObscuraModule';
import { primaryOnly } from './devices';
import { requestStartupPermissions } from './permissions';
import { getJsLog, logError } from '../utils/log';
import { acceptedFriends, pendingFriends, type Identity } from '../domain/friends';
import { deviceRole, toMe, type DeviceRole, type Session, type SignedIn } from '../domain/session';
import { cleanCode } from '../domain/qr';

export type {
  Friend,
  ConnectionState,
  ConversationItem,
  StoryItem,
  ProfileItem,
  DeviceRole,
  SignedIn,
};

interface State {
  session: Session;
  /** Every relationship, any status. */
  friends: Friend[];
  connState: ConnectionState;
  messages: ConversationItem[];
  stories: StoryItem[];
  profiles: ProfileItem[];
}

const SIGNED_OUT = {
  session: { status: 'signedOut' },
  friends: [],
  connState: 'disconnected',
  messages: [],
  stories: [],
  profiles: [],
} as const satisfies State;

export const useStore = create<State>(() => ({ ...SIGNED_OUT, session: { status: 'booting' } }));

/** Incremented on every `resetSession()` so in-flight reads from a signed-out session never write into the next one. */
let sessionEpoch = 0;

export function resetSession(): void {
  sessionEpoch += 1;
  useStore.setState(SIGNED_OUT);
}

/** Signs out locally even when the kit call fails. */
export async function logout(): Promise<void> {
  try {
    await Obscura.logout();
  } catch (e) {
    logError('logout', e);
  }
  resetSession();
}

// ─── Selectors ───────────────────────────────────────────

/* istanbul ignore next */
export function useSessionStatus(): Session['status'] {
  return useStore(s => s.session.status);
}

/* istanbul ignore next */
export function useConnState(): ConnectionState {
  return useStore(s => s.connState);
}

/**
 * The signed-in session, for screens that only mount while signed in. After sign-out it keeps
 * returning the last session, so a screen still animating out renders rather than throws.
 */
/* istanbul ignore next */
export function useSignedIn(): SignedIn {
  const session = useStore(s => s.session);
  const last = useRef<SignedIn | null>(null);
  if (session.status === 'signedIn') last.current = session;
  if (last.current === null) throw new Error('useSignedIn() used outside a signed-in session');
  return last.current;
}

/* istanbul ignore next */
export function useIdentity(): Identity {
  const { me } = useSignedIn();
  const friends = useStore(s => s.friends);
  return useMemo(
    () => ({ myUserId: me.userId, myUsername: me.username, friends }),
    [me.userId, me.username, friends],
  );
}

/* istanbul ignore next */
export function useAcceptedFriends(): Friend[] {
  const friends = useStore(s => s.friends);
  return useMemo(() => acceptedFriends(friends), [friends]);
}

/* istanbul ignore next */
export function usePendingFriends(): Friend[] {
  const friends = useStore(s => s.friends);
  return useMemo(() => pendingFriends(friends), [friends]);
}

/* istanbul ignore next */
export function useMessages(): ConversationItem[] {
  return useStore(s => s.messages);
}

/* istanbul ignore next */
export function useStories(): StoryItem[] {
  return useStore(s => s.stories);
}

/* istanbul ignore next */
export function useProfiles(): ProfileItem[] {
  return useStore(s => s.profiles);
}

// ─── Slice refresh & sync ────────────────────────────────
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

type Slice = 'messages' | 'stories' | 'profiles';

/** A coalesced, never-rejecting refresh of one slice that drops results from a previous session. */
function sliceRefresher<K extends Slice>(
  key: K,
  read: () => Promise<State[K]>,
): () => Promise<void> {
  return coalesce(async () => {
    const epoch = sessionEpoch;
    try {
      const value = await read();
      if (epoch !== sessionEpoch) return;
      useStore.setState({ [key]: value } as Pick<State, K>);
    } catch (e) {
      logError(`${key}.refresh`, e);
    }
  });
}

export const refreshMessages = sliceRefresher('messages', () => Obscura.getMessages());
export const refreshStories = sliceRefresher('stories', () => Obscura.getStories());
export const refreshProfiles = sliceRefresher('profiles', () => Obscura.getProfiles());

const REFRESH_FOR_MODEL: Record<EntryModel, () => Promise<void>> = {
  directMessage: refreshMessages,
  pix: refreshMessages,
  seen: refreshMessages,
  story: refreshStories,
  profile: refreshProfiles,
};

/** Refresh each slice the given models live in, once. */
async function refreshSlicesForModels(models: Iterable<EntryModel>): Promise<void> {
  const refreshers = new Set(Array.from(models, model => REFRESH_FOR_MODEL[model]));
  await Promise.all(Array.from(refreshers, refresh => refresh()));
}

export async function refreshAll(): Promise<void> {
  await Promise.all([refreshMessages(), refreshStories(), refreshProfiles()]);
}

/** Retry entries whose send reached nobody. */
export const flushOutboxFromStore: () => Promise<void> = coalesce(async () => {
  try {
    await Obscura.flushOutbox();
  } catch (e) {
    logError('outbox.flush', e);
  }
});

export const sweepAndRefresh: () => Promise<void> = coalesce(async () => {
  try {
    const touched = await Obscura.sweepExpired();
    await refreshSlicesForModels(touched);
  } catch (e) {
    logError('expiry.sweep', e);
  }
});

/** Everything "the network or the app came back" means: receive, retry and expire. */
async function syncAll(): Promise<void> {
  await Promise.all([refreshAll(), flushOutboxFromStore(), sweepAndRefresh()]);
}

const SWEEP_INTERVAL_MS = 30 * 1000;

// ─── Writes ──────────────────────────────────────────────

/** Send a seen receipt for an entry this user received. */
export async function markSeen(entryId: string): Promise<void> {
  try {
    await Obscura.markSeen(entryId);
  } finally {
    await refreshMessages();
  }
}

export async function saveOwnProfile(displayName: string, bio: string): Promise<void> {
  try {
    await Obscura.updateProfile(displayName, bio);
  } finally {
    await refreshProfiles();
  }
}

// ─── Session & Friends ───────────────────────────────────

/** Correct the role of the signed-in session, e.g. when the kit rejects a primary-only action. */
export function setDeviceRole(role: DeviceRole): void {
  const { session } = useStore.getState();
  if (session.status === 'signedIn') useStore.setState({ session: { ...session, role } });
}

export async function refreshFriends(): Promise<void> {
  const epoch = sessionEpoch;
  const friends = await Obscura.getFriends();
  if (epoch === sessionEpoch) useStore.setState({ friends });
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
    .then(intent => {
      if (intent) onScreen(intent.screen);
    })
    .catch(e => logError('launchIntent', e));
  return onObscuraEvent(event => {
    if (event.type === 'launchedFrom') onScreen(event.screen);
  });
}

export async function applyObscuraEvent(event: ObscuraEvent): Promise<void> {
  switch (event.type) {
    case 'friendsChanged':
      await refreshFriends().catch(e => logError('friends.refresh', e));
      return;
    case 'connectionChanged':
      useStore.setState({ connState: event.state });
      // The server redelivers anything unacknowledged on reconnect.
      if (event.state === 'connected') await syncAll();
      return;
    case 'authStateChanged':
      if (event.state === 'loggedOut') resetSession();
      else if (useStore.getState().session.status !== 'signedIn') await loadSession();
      return;
    case 'appStateChanged':
      // Native code may have stored rows while JS was suspended; only flush the outbox if connected.
      if (event.state === 'active') {
        await Promise.all([
          refreshAll(),
          useStore.getState().connState === 'connected'
            ? flushOutboxFromStore()
            : Promise.resolve(),
          sweepAndRefresh(),
        ]);
      }
      return;
    case 'pushTokenReceived':
      if (useStore.getState().session.status === 'signedIn') {
        await Obscura.registerPushToken(event.token).catch(e => logError('push.register', e));
      }
      return;
    case 'messageReceived':
      await refreshSlicesForModels([event.model]);
      return;
  }
}

/**
 * Read the session identity, role and friends, enter `signedIn`, then sync all domain slices.
 * Resolves false, entering `signedOut` (or writing nothing, if the session was reset while the reads
 * were in flight), when the kit reports no complete identity.
 */
export async function loadSession(): Promise<boolean> {
  const epoch = sessionEpoch;
  const pull = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    p.catch(e => {
      logError('session.load', e);
      return fallback;
    });
  const [userId, username, deviceId, isPrimary, connState, friends] = await Promise.all([
    pull(Obscura.getUserId(), null),
    pull(Obscura.getUsername(), null),
    pull(Obscura.getDeviceId(), null),
    pull(Obscura.isPrimary(), null),
    pull(Obscura.getConnectionState(), 'disconnected' as ConnectionState),
    pull(Obscura.getFriends(), [] as Friend[]),
  ]);
  if (epoch !== sessionEpoch) return false;
  const me = toMe(userId, username, deviceId);
  if (me === null) {
    useStore.setState({ session: { status: 'signedOut' } });
    return false;
  }
  useStore.setState({
    session: { status: 'signedIn', me, role: deviceRole(isPrimary) },
    connState,
    friends,
  });
  // Push can store rows with no JS running and `messageReceived` may be dropped, so cold start syncs.
  await syncAll();
  return true;
}

/** Enter the session the kit just authenticated; rejects if it reports none. */
export async function startSession(): Promise<void> {
  if (!(await loadSession())) throw new Error('Signed in, but the session could not be loaded');
}

/** The cold-start auth check: leaves `booting` for `signedIn` or `signedOut`, whatever happens. */
export async function bootstrapAuthState(): Promise<void> {
  try {
    if ((await Obscura.getAuthState()) === 'authenticated') await loadSession();
  } catch (e) {
    logError('bootstrap.authState', e);
  } finally {
    if (useStore.getState().session.status === 'booting') {
      useStore.setState({ session: { status: 'signedOut' } });
    }
  }
}

export function shouldRequestStartupPermissions(
  signedIn: boolean,
  connState: ConnectionState,
  alreadyRequested: boolean,
): boolean {
  return signedIn && connState === 'connected' && !alreadyRequested;
}

/** Mounted once at the app root: the auth check, the event subscription and the signed-in loops. */
/* istanbul ignore next */
export function ObscuraBootstrap(): null {
  useEffect(() => {
    bootstrapAuthState();
  }, []);

  useEffect(
    () =>
      onObscuraEvent(e => {
        applyObscuraEvent(e);
      }),
    [],
  );

  const signedIn = useStore(s => s.session.status === 'signedIn');
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => {
      sweepAndRefresh();
    }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [signedIn]);

  // Once per session, after the first connect. Android drops concurrent permission prompts.
  const connState = useStore(s => s.connState);
  const permissionsRequested = useRef(false);
  useEffect(() => {
    if (!signedIn) {
      permissionsRequested.current = false;
      return;
    }
    if (!shouldRequestStartupPermissions(signedIn, connState, permissionsRequested.current)) return;
    permissionsRequested.current = true;
    requestStartupPermissions().catch(e => logError('permissions.startup', e));
  }, [signedIn, connState]);

  return null;
}
