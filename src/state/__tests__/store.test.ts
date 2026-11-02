import {
  useStore, refreshMessages, refreshStories, refreshProfiles,
  markSeen, saveOwnProfile, applyObscuraEvent, loadSession,
  refreshFriends, resetSession, logout,
} from '../store';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

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
  bridge.__authenticate({ userId: SELF, deviceId: DEVICE });
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

describe('logout', () => {
  it('clears the session and tells the kit', async () => {
    session();
    useStore.setState({
      messages: [{
        id: 'm1', peerUserId: BOB, kind: 'message', authorUserId: BOB, sentAt: 1,
        viewedAt: null, content: 'hi', mediaRef: null, contentKey: null, nonce: null,
        mediaType: null, caption: null, captionMeta: null, displayDuration: 0,
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

describe('slice refresh', () => {
  it('refreshes messages, stories, and profiles from the bridge', async () => {
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });
    bridge.__deliverStory({ id: 's_1', authorUserId: BOB, content: 'my day' });
    bridge.__deliverProfile({ userId: BOB, displayName: 'Bob', bio: 'hi' });

    await Promise.all([refreshMessages(), refreshStories(), refreshProfiles()]);

    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
    expect(useStore.getState().stories.map((s) => s.id)).toEqual(['s_1']);
    expect(useStore.getState().profiles.map((p) => p.userId)).toEqual([BOB]);
  });

  it('swallows a refresh failure rather than rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    session();
    bridge.__failNext('getMessages', 'STORAGE_ERROR');

    await expect(refreshMessages()).resolves.toBeUndefined();
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

  it('refreshes and sweeps on foreground', async () => {
    session();
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });

    applyObscuraEvent({ type: 'appStateChanged', state: 'active' });
    await flush();

    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
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

  it('loads identity, friends, and all slices on cold start', async () => {
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: BOB, authorUserId: BOB, content: 'hello' });

    await loadSession();
    await flush();

    expect(useStore.getState().myUserId).toBe(SELF);
    expect(useStore.getState().friends).toHaveLength(1);
    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_1']);
  });

  it('flips authed on `authStateChanged: authenticated`', () => {
    expect(useStore.getState().authed).toBe(false);

    applyObscuraEvent({ type: 'authStateChanged', state: 'authenticated' });

    expect(useStore.getState().authed).toBe(true);
  });

  it('clears the session on `loggedOut`', () => {
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

describe('the outbox trigger', () => {
  it('retries an undelivered entry on reconnect', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    session();
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);
    bridge.__failNext('postStory', 'SEND_FAILED', 'offline');
    await expect(Obscura.postStory('stranded', null, null, null, null, null)).rejects.toThrow();
    expect(bridge.__sent).toEqual([]);

    applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });
    await flush();

    expect(bridge.__sent).toHaveLength(1);
    expect(bridge.__sent[0].payload.content).toBe('stranded');
    warn.mockRestore();
  });
});
