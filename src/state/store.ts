import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  Obscura, onObscuraEvent,
  type Friend, type ConnectionState, type ObscuraEvent,
  type ConversationItem, type StoryItem, type ProfileItem,
} from '../native/ObscuraModule';
import { primaryOnly } from './devices';
import { requestStartupPermissions } from './permissions';
import { getJsLog, logError } from '../utils/log';
import { acceptedFriends, pendingFriends, type Identity } from '../domain/friends';
import { cleanCode } from '../domain/qr';

export type { Friend, ConnectionState, ConversationItem, StoryItem, ProfileItem };

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
  messages: ConversationItem[];
  stories: StoryItem[];
  profiles: ProfileItem[];
}

const SIGNED_OUT = {
  authed: false,
  myUserId: '',
  myUsername: '',
  myDeviceId: '',
  isPrimary: null,
  friends: [],
  connState: 'disconnected',
  messages: [],
  stories: [],
  profiles: [],
} as const satisfies Omit<Session, 'bootstrapped'>;

export const useStore = create<Session>(() => ({ bootstrapped: false, ...SIGNED_OUT }));

/** Incremented on every `resetSession()` so in-flight reads from a signed-out session never write into the next one. */
let sessionEpoch = 0;

export function resetSession(): void {
  sessionEpoch += 1;
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

export function useMessages(): ConversationItem[] {
  return useStore((s) => s.messages);
}

export function useStories(): StoryItem[] {
  return useStore((s) => s.stories);
}

export function useProfiles(): ProfileItem[] {
  return useStore((s) => s.profiles);
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

export const refreshMessages: () => Promise<void> = coalesce(async () => {
  const epoch = sessionEpoch;
  try {
    const messages = await Obscura.getMessages();
    if (epoch !== sessionEpoch) return;
    useStore.setState({ messages });
  } catch (e) {
    logError('messages.refresh', e);
  }
});

export const refreshStories: () => Promise<void> = coalesce(async () => {
  const epoch = sessionEpoch;
  try {
    const stories = await Obscura.getStories();
    if (epoch !== sessionEpoch) return;
    useStore.setState({ stories });
  } catch (e) {
    logError('stories.refresh', e);
  }
});

export const refreshProfiles: () => Promise<void> = coalesce(async () => {
  const epoch = sessionEpoch;
  try {
    const profiles = await Obscura.getProfiles();
    if (epoch !== sessionEpoch) return;
    useStore.setState({ profiles });
  } catch (e) {
    logError('profiles.refresh', e);
  }
});

async function refreshSlicesForModels(models: Iterable<string>): Promise<void> {
  let needMessages = false;
  let needStories = false;
  let needProfiles = false;
  for (const model of models) {
  switch (model) {
    case 'directMessage':
    case 'pix':
    case 'seen':
      needMessages = true;
      break;
    case 'story':
      needStories = true;
      break;
    case 'profile':
      needProfiles = true;
      break;
  }
  }
  await Promise.all([
    needMessages ? refreshMessages() : Promise.resolve(),
    needStories ? refreshStories() : Promise.resolve(),
    needProfiles ? refreshProfiles() : Promise.resolve(),
  ]);
}

export async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshMessages(),
    refreshStories(),
    refreshProfiles(),
  ]);
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
  await Promise.all([
    refreshAll(),
    flushOutboxFromStore(),
    sweepAndRefresh(),
  ]);
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

export async function applyObscuraEvent(event: ObscuraEvent): Promise<void> {
  switch (event.type) {
    case 'friendsChanged':
      await refreshFriends().catch((e) => logError('friends.refresh', e));
      return;
    case 'connectionChanged':
      useStore.setState({ connState: event.state });
      // The server redelivers anything unacknowledged on reconnect.
      if (event.state === 'connected') await syncAll();
      return;
    case 'authStateChanged':
      if (event.state === 'loggedOut') resetSession();
      else useStore.setState({ authed: true });
      return;
    case 'appStateChanged':
      // Native code may have stored rows while JS was suspended; only flush the outbox if connected.
      if (event.state === 'active') {
        await Promise.all([
          refreshAll(),
          useStore.getState().connState === 'connected' ? flushOutboxFromStore() : Promise.resolve(),
          sweepAndRefresh(),
        ]);
      }
      return;
    case 'pushTokenReceived':
      await Obscura.registerPushToken(event.token).catch((e) => logError('push.register', e));
      return;
    case 'messageReceived':
      await refreshSlicesForModels([event.model]);
      return;
  }
}

/** Load the session identity and friends atomically, then sync all domain slices. */
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

export async function bootstrapAuthState(): Promise<void> {
  try {
    const state = await Obscura.getAuthState();
    if (state === 'authenticated') {
      await loadSession();
      useStore.setState({ authed: true });
    }
  } catch (e) {
    logError('bootstrap.authState', e);
  } finally {
    useStore.setState({ bootstrapped: true });
  }
}

export async function ensureSessionLoaded(): Promise<void> {
  if (useStore.getState().myUserId === '') {
    await loadSession();
  }
}

export function shouldRequestStartupPermissions(
  authed: boolean,
  connState: ConnectionState,
  alreadyRequested: boolean,
): boolean {
  return authed && connState === 'connected' && !alreadyRequested;
}

/** Mounted once at the app root: the auth check, the event subscription and the signed-in loops. */
export function ObscuraBootstrap(): null {
  useEffect(() => {
    bootstrapAuthState();
  }, []);

  useEffect(() => onObscuraEvent((e) => { applyObscuraEvent(e); }), []);

  const authed = useStore((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    ensureSessionLoaded();
    const timer = setInterval(() => { sweepAndRefresh(); }, SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authed]);

  // Once per session, after the first connect. Android drops concurrent permission prompts.
  const connState = useStore((s) => s.connState);
  const permissionsRequested = useRef(false);
  useEffect(() => {
    if (!authed) { permissionsRequested.current = false; return; }
    if (!shouldRequestStartupPermissions(authed, connState, permissionsRequested.current)) return;
    permissionsRequested.current = true;
    requestStartupPermissions().catch((e) => logError('permissions.startup', e));
  }, [authed, connState]);

  return null;
}
