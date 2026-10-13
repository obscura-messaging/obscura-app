import { putEntry } from '../entryStore';
import {
  useStore, loadEntries, drainAndRefresh, saveEntry, markSeen,
  applyObscuraEvent, loadSession, refreshFriends, resetSession, logout,
} from '../store';
import { SEEN_MODEL, seenEntryId } from '../../domain/seen';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';
const CONV = [SELF, BOB].sort().join('_');

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
    useStore.setState({ entries: { story: [] } });

    await logout();

    expect(useStore.getState()).toMatchObject({ authed: false, myUserId: '', friends: [], entries: {} });
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

describe('seen receipts', () => {
  /** Seen state comes only from a receipt by the other participant, never from the entry itself. */
  it('derives viewedAt from a receipt, not from the entry payload', async () => {
    await Obscura.entryPut(
      'directMessage', 'dm_1',
      JSON.stringify({ conversationId: CONV, content: 'hi', viewedAt: 1, _authorUserId: BOB }), 1_000, 'd', null,
    );

    await loadEntries('directMessage');
    expect(useStore.getState().entries.directMessage?.[0].viewedAt).toBeNull();

    await Obscura.entryPut(
      SEEN_MODEL, seenEntryId('directMessage', 'dm_1'),
      JSON.stringify({ conversationId: CONV, viewedAt: 2_000, _authorUserId: SELF }), 2_000, 'd', null,
    );
    await loadEntries('directMessage');
    expect(useStore.getState().entries.directMessage?.[0].viewedAt).toBe(2_000);
  });

  it('markSeen sends a receipt to the conversation and leaves the message untouched', async () => {
    session();
    await Obscura.entryPut(
      'directMessage', 'dm_1', JSON.stringify({ conversationId: CONV, content: 'hi', _authorUserId: BOB }), 1_000, 'd', null,
    );
    await loadEntries('directMessage');

    await markSeen('directMessage', useStore.getState().entries.directMessage![0]);

    const sent = bridge.__sent.find((x) => x.modelKey === SEEN_MODEL);
    expect(sent).toMatchObject({ recipientUserIds: [BOB], entryId: seenEntryId('directMessage', 'dm_1') });
    expect(JSON.parse((await Obscura.entryAll('directMessage'))[0].data).content).toBe('hi');
    expect(typeof useStore.getState().entries.directMessage?.[0].viewedAt).toBe('number');
  });
});

describe('loadEntries', () => {
  it('parses the stored JSON into the cache', async () => {
    const entry = { id: 's1', sentAt: 1_000, authorUserId: BOB, authorDeviceId: 'd', data: { content: 'hi' } };
    await putEntry('story', entry);

    await loadEntries('story');

    expect(useStore.getState().entries.story).toEqual([{ ...entry, viewedAt: null }]);
  });

  /** One unreadable row is a bug to fix, not a reason to show the user nothing. */
  it('skips a row it cannot decode and keeps the rest', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Obscura.entryPut('story', 'bad', 'not json', 1, 'd', null);
    await Obscura.entryPut('story', 'anonymous', JSON.stringify({ content: 'no author' }), 1, 'd', null);
    await putEntry('story', { id: 'good', sentAt: 2, authorUserId: BOB, authorDeviceId: 'd', data: { content: 'ok' } });

    await loadEntries('story');

    expect(useStore.getState().entries.story).toHaveLength(1);
    expect(useStore.getState().entries.story?.[0].id).toBe('good');
    warn.mockRestore();
  });

  /** `undefined` means never-loaded and `[]` means loaded-and-empty; the refresh logic reads both. */
  it('creates the slot even when the model is empty', async () => {
    await loadEntries('pix');

    expect(useStore.getState().entries.pix).toEqual([]);
  });
});

describe('drainAndRefresh', () => {
  it('drains the inbox into the store and refreshes a slice a screen has opened', async () => {
    session();
    await loadEntries('directMessage'); // a screen opened this model
    bridge.__deliverInbox({
      senderUserId: BOB, entryId: 'dm_1',
      payload: JSON.stringify({ conversationId: CONV, content: 'hello' }),
    });

    await drainAndRefresh();

    expect(await Obscura.inboxDepth()).toBe(0);
    expect(useStore.getState().entries.directMessage).toHaveLength(1);
  });

  /** A model no screen has opened is drained to the store but not pulled into memory. */
  it('does not fetch a model nobody has opened', async () => {
    session();
    bridge.__deliverInbox({
      senderUserId: BOB, entryId: 'dm_1',
      payload: JSON.stringify({ conversationId: CONV, content: 'hello' }),
    });

    await drainAndRefresh();

    expect(useStore.getState().entries.directMessage).toBeUndefined();
    expect(await Obscura.entryAll('directMessage')).toHaveLength(1);
  });

  /** A drain failure must not propagate into an event handler that cannot do anything with it. */
  it('swallows a drain failure rather than rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    session();
    bridge.__failNext('inboxPeek', 'PEEK_ERROR');

    await expect(drainAndRefresh()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('saveEntry', () => {
  it('refuses to write before the session identity has loaded', async () => {
    await expect(saveEntry('story', { content: 'x' }))
      .rejects.toThrow('before the session identity loaded');

    expect(bridge.__calls).not.toContain('entryPut');
  });

  it('refuses when the device id is missing even though the user id is not', async () => {
    useStore.setState({ myUserId: SELF });

    await expect(saveEntry('story', { content: 'x' })).rejects.toThrow();
  });

  it('stores, sends, and refreshes the model so the screen shows it', async () => {
    session();
    await loadEntries('story');

    const id = await saveEntry('story', { content: 'mine' });

    expect(useStore.getState().entries.story).toHaveLength(1);
    expect(useStore.getState().entries.story?.[0].id).toBe(id);
    expect(bridge.__sent).toHaveLength(1);
  });

  it('refreshes the model even when the send fails', async () => {
    session();
    await loadEntries('directMessage');
    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');

    await expect(saveEntry('directMessage', { conversationId: CONV, content: 'hi' }))
      .rejects.toThrow('offline');

    expect(useStore.getState().entries.directMessage).toHaveLength(1);
    expect(useStore.getState().entries.directMessage?.[0].data.content).toBe('hi');
  });

  /** Nothing was stored, so the refresh is a no-op read rather than a wrong one. */
  it('leaves the cache empty when the audience could not be resolved', async () => {
    session();
    await loadEntries('directMessage');

    await expect(saveEntry('directMessage', { content: 'no conversation id' })).rejects.toThrow();

    expect(useStore.getState().entries.directMessage).toEqual([]);
  });
});

describe('the drain triggers', () => {
  /** Every one of these is a moment the inbox may have grown with no `messageReceived` to say so. */
  async function deliverAndTrigger(fire: () => void): Promise<void> {
    session();
    bridge.__deliverInbox({
      senderUserId: BOB, entryId: 'dm_1',
      payload: JSON.stringify({ conversationId: CONV, content: 'hello' }),
    });
    fire();
    await flush();
  }

  it('drains on reconnect — the moment the server redelivers what it did not see acked', async () => {
    await deliverAndTrigger(() => applyObscuraEvent({ type: 'connectionChanged', state: 'connected' }));

    expect(await Obscura.inboxDepth()).toBe(0);
    expect(useStore.getState().connState).toBe('connected');
  });

  it('does not drain on a connection state that is not `connected`', async () => {
    await deliverAndTrigger(() => applyObscuraEvent({ type: 'connectionChanged', state: 'reconnecting' }));

    expect(await Obscura.inboxDepth()).toBe(1);
  });

  /** Foreground sync discovers rows persisted while the JS runtime was inactive. */
  it('drains on foreground', async () => {
    await deliverAndTrigger(() => applyObscuraEvent({ type: 'appStateChanged', state: 'active' }));

    expect(await Obscura.inboxDepth()).toBe(0);
  });

  it('does not drain on background', async () => {
    await deliverAndTrigger(() => applyObscuraEvent({ type: 'appStateChanged', state: 'background' }));

    expect(await Obscura.inboxDepth()).toBe(1);
  });

  /** The event is only a wake-up: under the thin kit the data is in the inbox, not in the event. */
  it('drains on messageReceived rather than merely refreshing', async () => {
    await deliverAndTrigger(() =>
      applyObscuraEvent({ type: 'messageReceived', model: 'directMessage' }));

    expect(await Obscura.inboxDepth()).toBe(0);
    expect(await Obscura.entryAll('directMessage')).toHaveLength(1);
  });

  it('drains on cold start, after pulling the identity it needs to authorize with', async () => {
    bridge.__setFriends([{ userId: BOB, username: 'bob', status: 'accepted' }]);
    bridge.__deliverInbox({
      senderUserId: BOB, entryId: 'dm_1',
      payload: JSON.stringify({ conversationId: CONV, content: 'hello' }),
    });

    await loadSession();
    await flush();

    expect(useStore.getState().myUserId).toBe(SELF);
    expect(useStore.getState().friends).toHaveLength(1);
    expect(await Obscura.inboxDepth()).toBe(0);
  });

  it('flips authed on `authStateChanged: authenticated`, which is what runs the cold-start drain', () => {
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
    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');
    await expect(saveEntry('story', { content: 'stranded' })).rejects.toThrow();
    expect(bridge.__sent).toEqual([]);

    applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });
    await flush();

    expect(bridge.__sent).toHaveLength(1);
    expect(JSON.parse(bridge.__sent[0].payloadJson).content).toBe('stranded');
    warn.mockRestore();
  });
});
