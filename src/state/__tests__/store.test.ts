import {
  useStore, refreshMessages, refreshStories, refreshProfiles,
  markSeen, saveOwnProfile, applyObscuraEvent, loadSession,
  refreshFriends, resetSession, logout, flushOutboxFromStore, sweepAndRefresh,
  subscribeToLaunchScreen, loadDebugLog, copyToClipboard, getFriendCode,
  bootstrapAuthState, ensureSessionLoaded, shouldRequestStartupPermissions,
} from '../store';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';
import { openPixViewer } from '../../navigation/openPixViewer';
import { logError } from '../../utils/log';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Let the fire-and-forget promises inside the event handlers settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

function session() {
  useStore.setState({
    authed: true, myUserId: SELF, myUsername: 'me', myDeviceId: DEVICE,
    friends: [{ userId: BOB, username: 'bob', status: 'accepted' }],
  });
}

beforeEach(() => {
  resetSession();
  bridge.__authenticate({ userId: SELF, username: 'me', deviceId: DEVICE });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('refreshFriends', () => {
  it('pulls every relationship, whatever its status', async () => {
    bridge.__setFriends([
      { userId: BOB, username: 'bob', status: 'accepted' },
      { userId: 'carol', username: 'carol', status: 'pending_received' },
    ]);

    await refreshFriends();

    expect(useStore.getState().friends.map((f) => f.username)).toEqual(['bob', 'carol']);
  });
});

describe('logout & sessionEpoch race protection', () => {
  it('clears the session and tells the kit', async () => {
    session();
    useStore.setState({
      messages: [{
        kind: 'message', id: 'm1', peerUserId: BOB, authorUserId: BOB, sentAt: 1,
        viewedAt: null, content: 'hi',
      }],
    });

    await logout();

    expect(useStore.getState()).toMatchObject({
      authed: false, myUserId: '', friends: [], messages: [], stories: [], profiles: [],
    });
    expect(bridge.__calls).toContain('logout');
  });

  /** A user who taps logout must not stay signed in because the network was down. */
  it('clears the session even when the kit call fails', async () => {
    session();
    bridge.__failNext('logout', 'SEND_FAILED', 'network down');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await logout();

    expect(useStore.getState().authed).toBe(false);
    warn.mockRestore();
  });

  it('discards stale in-flight getMessages, getStories, and getProfiles responses across resetSession/logout', async () => {
    session();
    let resolveMessages!: (v: any) => void;
    let resolveStories!: (v: any) => void;
    let resolveProfiles!: (v: any) => void;

    jest.spyOn(bridge, 'getMessages').mockImplementationOnce(
      () => new Promise((r) => { resolveMessages = r; }),
    );
    jest.spyOn(bridge, 'getStories').mockImplementationOnce(
      () => new Promise((r) => { resolveStories = r; }),
    );
    jest.spyOn(bridge, 'getProfiles').mockImplementationOnce(
      () => new Promise((r) => { resolveProfiles = r; }),
    );

    const inflight = Promise.all([refreshMessages(), refreshStories(), refreshProfiles()]);
    await logout();

    resolveMessages([{
      kind: 'message', id: 'stale_m', peerUserId: BOB, authorUserId: BOB, sentAt: 1, viewedAt: null, content: 'stale',
    }]);
    resolveStories([{
      id: 'stale_s', authorUserId: BOB, sentAt: 1, content: 'stale', attachment: null, captionMeta: null,
    }]);
    resolveProfiles([{
      userId: BOB, authorDeviceId: 'd', updatedAt: 1, displayName: 'Stale', bio: '',
    }]);
    await inflight;

    expect(useStore.getState().messages).toEqual([]);
    expect(useStore.getState().stories).toEqual([]);
    expect(useStore.getState().profiles).toEqual([]);
  });
});

describe('seen receipts & profile writes', () => {
  it('markSeen marks the entry through the bridge and refreshes messages', async () => {
    session();
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hi' });
    await refreshMessages();
    expect(useStore.getState().messages[0].viewedAt).toBeNull();

    await markSeen('dm_1');

    const sent = bridge.__sent.find((x) => x.modelKey === 'seen');
    expect(sent).toMatchObject({ recipientUserIds: [BOB], entryId: 'seen_directMessage_dm_1' });
    expect(typeof useStore.getState().messages[0].viewedAt).toBe('number');
  });

  it('saveOwnProfile updates the profile through the bridge and refreshes profiles', async () => {
    session();
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);

    await saveOwnProfile('Alice', 'In Wonderland');

    expect(useStore.getState().profiles).toEqual([
      expect.objectContaining({ userId: SELF, displayName: 'Alice', bio: 'In Wonderland' }),
    ]);
    expect(bridge.__sent.find((x) => x.modelKey === 'profile')).toMatchObject({
      recipientUserIds: [BOB],
    });
  });
});

describe('slice refresh & coalescing', () => {
  it('refreshes messages, stories, and profiles from the bridge', async () => {
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });
    bridge.__deliverStory({ id: 's_1', authorUserId: BOB, content: 'my day' });
    bridge.__deliverProfile({ userId: BOB, displayName: 'Bob', bio: 'hi' });

    await Promise.all([refreshMessages(), refreshStories(), refreshProfiles()]);

    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
    expect(useStore.getState().stories.map((s) => s.id)).toEqual(['s_1']);
    expect(useStore.getState().profiles.map((p) => p.userId)).toEqual([BOB]);
  });

  it('coalesces concurrent refreshStories, refreshProfiles, flushOutboxFromStore, and sweepAndRefresh calls into at most one in-flight + one trailing pass', async () => {
    bridge.__setSweepResult(['story']);
    bridge.__calls.length = 0;

    await Promise.all([refreshStories(), refreshStories(), refreshStories()]);
    expect(bridge.__calls.filter((c) => c === 'getStories')).toHaveLength(2);

    bridge.__calls.length = 0;
    await Promise.all([refreshProfiles(), refreshProfiles(), refreshProfiles()]);
    expect(bridge.__calls.filter((c) => c === 'getProfiles')).toHaveLength(2);

    bridge.__calls.length = 0;
    await Promise.all([flushOutboxFromStore(), flushOutboxFromStore(), flushOutboxFromStore()]);
    expect(bridge.__calls.filter((c) => c === 'flushOutbox')).toHaveLength(2);

    bridge.__calls.length = 0;
    await Promise.all([sweepAndRefresh(), sweepAndRefresh(), sweepAndRefresh()]);
    expect(bridge.__calls.filter((c) => c === 'sweepExpired')).toHaveLength(2);
  });

  it('swallows refresh, flushOutbox, and sweepExpired failures rather than rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    session();
    bridge.__failNext('getMessages', 'STORAGE_ERROR');
    bridge.__failNext('getStories', 'STORAGE_ERROR');
    bridge.__failNext('getProfiles', 'STORAGE_ERROR');
    bridge.__failNext('flushOutbox', 'STORAGE_ERROR');
    bridge.__failNext('sweepExpired', 'STORAGE_ERROR');

    await expect(Promise.all([
      refreshMessages(),
      refreshStories(),
      refreshProfiles(),
      flushOutboxFromStore(),
      sweepAndRefresh(),
    ])).resolves.toBeDefined();
    warn.mockRestore();
  });
});

describe('event and lifecycle sync triggers', () => {
  it('refreshes all slices, flushes outbox, and sweeps expired on reconnect', async () => {
    session();
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });

    applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });
    await flush();

    expect(useStore.getState().connState).toBe('connected');
    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
    expect(bridge.__calls).toContain('flushOutbox');
    expect(bridge.__calls).toContain('sweepExpired');
  });

  it('does not sync on a connection state that is not `connected`', async () => {
    session();
    const callsBefore = bridge.__calls.length;

    applyObscuraEvent({ type: 'connectionChanged', state: 'reconnecting' });
    await flush();

    expect(bridge.__calls.slice(callsBefore)).toEqual([]);
  });

  it('refreshes, sweeps, and flushes outbox when foregrounded while connected', async () => {
    session();
    useStore.setState({ connState: 'connected' });
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });
    bridge.__calls.length = 0;

    applyObscuraEvent({ type: 'appStateChanged', state: 'active' });
    await flush();

    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
    expect(bridge.__calls).toContain('flushOutbox');
    expect(bridge.__calls).toContain('sweepExpired');
  });

  it('does not sync on background', async () => {
    session();
    const callsBefore = bridge.__calls.length;

    applyObscuraEvent({ type: 'appStateChanged', state: 'background' });
    await flush();

    expect(bridge.__calls.slice(callsBefore)).toEqual([]);
  });

  it('refreshes only the affected slice on messageReceived', async () => {
    session();
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });
    applyObscuraEvent({ type: 'messageReceived', model: 'directMessage' });
    await flush();
    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);

    bridge.__deliverStory({ id: 's_1', authorUserId: BOB, content: 'story' });
    applyObscuraEvent({ type: 'messageReceived', model: 'story' });
    await flush();
    expect(useStore.getState().stories.map((s) => s.id)).toEqual(['s_1']);

    bridge.__deliverProfile({ userId: BOB, displayName: 'Bobby' });
    applyObscuraEvent({ type: 'messageReceived', model: 'profile' });
    await flush();
    expect(useStore.getState().profiles.map((p) => p.displayName)).toEqual(['Bobby']);
  });

  it('loads identity, friends, and all slices on cold start, falling back on individual pull failures', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });
    bridge.__failNext('getFriends', 'STORAGE_ERROR');

    await loadSession();
    await flush();

    expect(useStore.getState().myUserId).toBe(SELF);
    expect(useStore.getState().friends).toEqual([]);
    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
    warn.mockRestore();
  });

  it('flips authed on `authStateChanged: authenticated` and clears on `loggedOut`', () => {
    expect(useStore.getState().authed).toBe(false);

    applyObscuraEvent({ type: 'authStateChanged', state: 'authenticated' });
    expect(useStore.getState().authed).toBe(true);

    session();
    applyObscuraEvent({ type: 'authStateChanged', state: 'loggedOut' });
    expect(useStore.getState().authed).toBe(false);
    expect(useStore.getState().myUserId).toBe('');
  });

  it('refreshes the friend graph after friendsChanged', async () => {
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);
    useStore.setState({ friends: [] });

    applyObscuraEvent({ type: 'friendsChanged' });
    await flush();

    expect(useStore.getState().friends.map((f) => f.username)).toEqual(['bob']);
  });

  it('registers a push token when one arrives', async () => {
    applyObscuraEvent({ type: 'pushTokenReceived', token: 'token-abcdefgh' });
    await flush();

    expect(bridge.__registeredPushToken()).toBe('token-abcdefgh');
  });
});

describe('launch intent, debug log, clipboard & friend code helpers', () => {
  it('delivers both cold-start getLaunchIntent and warm launchedFrom events via subscribeToLaunchScreen', async () => {
    bridge.launchIntent = { screen: 'ChatList' };
    const screens: string[] = [];

    const off = subscribeToLaunchScreen((s) => screens.push(s));
    await flush();
    expect(screens).toEqual(['ChatList']);

    bridge.__emit({ type: 'launchedFrom', screen: 'Profile' });
    expect(screens).toEqual(['ChatList', 'Profile']);

    off();
    bridge.__emit({ type: 'launchedFrom', screen: 'Camera' });
    expect(screens).toEqual(['ChatList', 'Profile']);
  });

  it('combines native and JS debug logs, copies to clipboard, and fetches the friend code', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.debugLog = ['00:00:01 Native boot'];
    logError('test.tag', new Error('boom'));

    const lines = await loadDebugLog();
    expect(lines[0]).toBe('00:00:01 Native boot');
    expect(lines.some((l) => l.includes('[test.tag] boom'))).toBe(true);

    await copyToClipboard('copied-text');
    expect(bridge.clipboard).toBe('copied-text');

    expect(await getFriendCode()).toBe(`${SELF}:me`);
    warn.mockRestore();
  });

  it('bootstraps auth state, ensures session is loaded once, and gates startup permission requests', async () => {
    useStore.setState({ bootstrapped: false, authed: false, myUserId: '' });
    await bootstrapAuthState();
    expect(useStore.getState()).toMatchObject({ bootstrapped: true, authed: true, myUserId: SELF });

    resetSession();
    useStore.setState({ bootstrapped: false });
    await bridge.logout();
    bridge.__calls.length = 0;
    await bootstrapAuthState();
    expect(useStore.getState()).toMatchObject({ bootstrapped: true, authed: false, myUserId: '' });
    expect(bridge.__calls).not.toContain('getUserId');

    bridge.__authenticate({ userId: SELF, username: 'me', deviceId: DEVICE });
    await ensureSessionLoaded();
    expect(useStore.getState().myUserId).toBe(SELF);

    bridge.__calls.length = 0;
    await ensureSessionLoaded();
    expect(bridge.__calls).not.toContain('getUserId');

    expect(shouldRequestStartupPermissions(true, 'connected', false)).toBe(true);
    expect(shouldRequestStartupPermissions(false, 'connected', false)).toBe(false);
    expect(shouldRequestStartupPermissions(true, 'disconnected', false)).toBe(false);
    expect(shouldRequestStartupPermissions(true, 'connected', true)).toBe(false);

    const navigate = jest.fn();
    openPixViewer({ navigate } as any, { userId: BOB, username: 'bob' }, []);
    expect(navigate).not.toHaveBeenCalled();
    openPixViewer(
      { navigate } as any,
      { userId: BOB, username: 'bob' },
      [{ id: 'p2', sentAt: 200 }, { id: 'p1', sentAt: 100 }],
    );
    expect(navigate).toHaveBeenCalledWith('StoryViewer', {
      mode: 'pix',
      userId: BOB,
      username: 'bob',
      entryIds: ['p1', 'p2'],
    });
  });
});

