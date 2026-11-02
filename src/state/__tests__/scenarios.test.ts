import {
  useStore, loadSession, loadEntries, drainAndRefresh, flushOutboxFromStore, sweepAndRefresh,
  applyObscuraEvent, addFriend, acceptFriend, removeFriend, saveEntry, markSeen, resetSession,
} from '../store';
import { notifyTyping } from '../chat';
import { logIn, linkThisDevice } from '../login';
import { sendCapture, type Capture } from '../sendMedia';
import { conversationId } from '../../domain/audience';
import { activityPreview, chatTimeline, friendActivities } from '../../domain/chats';
import { EXPIRE_AFTER_MS, SEEN_MODEL, seenEntryId } from '../../domain/expiry';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const ALICE = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB: Friend = { userId: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'accepted' };
const CONV = conversationId(ALICE, BOB.userId);

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  resetSession();
  bridge.__authenticate({ userId: ALICE, username: 'alice', deviceId: DEVICE });
});

describe('Scenario 1: device relink + friend handshake', () => {
  it('wipes a mismatched device, links as secondary, then manages friends on primary', async () => {
    bridge.__setLoginScenario('deviceMismatch');
    const origLogin = bridge.login.bind(bridge);
    jest.spyOn(bridge, 'login').mockImplementationOnce(async (u, p) => {
      const res = await origLogin(u, p);
      bridge.__setLoginScenario('linkRequired');
      return res;
    });

    expect(await logIn('alice', 'password-1234')).toBe('linkRequired');

    const codes: string[] = [];
    const linking = linkThisDevice('alice', 'password-1234', (code) => codes.push(code));
    await flush();
    expect(codes).toHaveLength(1);
    bridge.__approvePendingLink();
    await linking;

    await loadSession();
    expect(useStore.getState()).toMatchObject({
      authed: true,
      myUserId: ALICE,
      myUsername: 'alice',
      isPrimary: false,
    });

    // Switch to primary and run the friend lifecycle through store actions.
    bridge.__setPrimary(true);
    await loadSession();
    expect(useStore.getState().isPrimary).toBe(true);

    await addFriend('obscura:friend:bob-code');
    expect(useStore.getState().friends).toEqual([
      expect.objectContaining({ status: 'pending_sent' }),
    ]);

    const pendingId = useStore.getState().friends[0].userId;
    bridge.__setFriends([{ userId: pendingId, username: 'bob', status: 'pending_received' }]);
    await acceptFriend(pendingId);
    expect(useStore.getState().friends[0].status).toBe('accepted');

    await removeFriend(pendingId);
    expect(useStore.getState().friends).toEqual([]);
  });
});

describe('Scenario 2: offline capture -> outbox flush -> view-once receipt -> 15m expiry & replay block', () => {
  it('queues an offline capture, flushes on reconnect, tracks seen state, and sweeps after 15m', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setFriends([BOB]);
    await loadSession();
    await loadEntries('directMessage');
    await loadEntries('pix');
    await loadEntries('story');

    // 1. Alice captures a photo while Bob is unreachable.
    bridge.__setUnreachable([BOB.userId]);
    const capture: Capture = { path: '/tmp/shot.jpg', mediaType: 'photo', caption: 'secret', displayDuration: 5 };
    const undelivered = await sendCapture(capture, [BOB], true);

    expect(undelivered).toEqual(['bob', 'My story']);
    expect(bridge.__calls).toContain('deleteFile');
    expect(useStore.getState().entries.pix).toHaveLength(1);
    expect(useStore.getState().entries.story).toHaveLength(1);

    const [pixEntry] = useStore.getState().entries.pix!;
    let [bobActivity] = friendActivities(useStore.getState().friends, ALICE, [], useStore.getState().entries.pix!);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix delivered', highlight: false });

    // 2. Network reconnects: outbox flushes both the pix and the story to Bob.
    bridge.__setUnreachable([]);
    applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });
    await flush();

    expect(bridge.__sent.filter((s) => s.modelKey === 'pix' && s.recipientUserIds.includes(BOB.userId))).toHaveLength(2);
    expect(bridge.__sent.filter((s) => s.modelKey === 'story' && s.recipientUserIds.includes(BOB.userId))).toHaveLength(2);

    // 3. Bob opens the pix and his seen receipt arrives in Alice's inbox.
    const viewedAt = pixEntry.sentAt + 5_000;
    bridge.__deliverInbox({
      senderUserId: BOB.userId,
      modelKey: SEEN_MODEL,
      entryId: seenEntryId('pix', pixEntry.id),
      sentAt: viewedAt,
      payload: JSON.stringify({ conversationId: CONV, viewedAt }),
    });
    await drainAndRefresh();

    expect(useStore.getState().entries.pix?.[0].viewedAt).toBe(viewedAt);
    [bobActivity] = friendActivities(useStore.getState().friends, ALICE, [], useStore.getState().entries.pix!);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix opened', highlight: false });

    // 4. 15 minutes pass after viewing: the sweep erases the pix, its receipt, and its decrypted media,
    //    and writes an `_erased` tombstone that blocks any replayed copy.
    await Obscura.entryErase('pix', []); // no-op sanity
    const expiredNow = viewedAt + EXPIRE_AFTER_MS + 1;
    const touched = await (await import('../expiry')).sweepExpired(expiredNow);
    expect(touched).toContain('pix');
    await sweepAndRefresh();
    await loadEntries('pix');

    expect(useStore.getState().entries.pix).toEqual([]);
    expect(bridge.__purged).toContain(pixEntry.data.mediaRef);

    // 5. A replayed envelope for the erased pix is ignored and never resurrected.
    bridge.__deliverInbox({
      senderUserId: ALICE,
      modelKey: 'pix',
      entryId: pixEntry.id,
      sentAt: pixEntry.sentAt,
      payload: JSON.stringify(pixEntry.data),
    });
    await drainAndRefresh();
    expect(useStore.getState().entries.pix).toEqual([]);

    warn.mockRestore();
  });
});

describe('Scenario 3: incoming pix viewed locally + concurrent first-load race', () => {
  it('keeps refreshes that complete while the initial loadEntries call is still in flight', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    // Start loading `directMessage` (marks `openedModels` immediately) while draining a new message.
    const firstLoad = loadEntries('directMessage');
    bridge.__deliverInbox({
      senderUserId: BOB.userId,
      modelKey: 'directMessage',
      entryId: 'dm_race',
      payload: JSON.stringify({ conversationId: CONV, content: 'arrived during mount' }),
    });
    await Promise.all([firstLoad, drainAndRefresh()]);

    expect(useStore.getState().entries.directMessage?.map((m) => m.id)).toEqual(['dm_race']);
  });

  it('highlights an incoming unopened pix in activityPreview until markSeen marks it viewed', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();
    await loadEntries('pix');

    bridge.__deliverInbox({
      senderUserId: BOB.userId,
      modelKey: 'pix',
      entryId: 'pix_in_1',
      payload: JSON.stringify({
        conversationId: CONV,
        mediaRef: 'att_1',
        contentKey: 'k',
        nonce: 'n',
        mediaType: 'photo',
        caption: 'look!',
        displayDuration: 5,
      }),
    });
    await drainAndRefresh();

    let [activity] = friendActivities(useStore.getState().friends, ALICE, [], useStore.getState().entries.pix!);
    expect(activity.unopenedPix).toHaveLength(1);
    expect(activityPreview(activity, ALICE)).toEqual({ text: 'New pix · tap to view', highlight: true });
    expect(chatTimeline([], useStore.getState().entries.pix!, CONV, ALICE)).toEqual([
      { kind: 'pix', id: 'pix_in_1', sentAt: expect.any(Number), authorUserId: BOB.userId, status: 'received_new' },
    ]);

    await markSeen('pix', activity.unopenedPix[0]);

    [activity] = friendActivities(useStore.getState().friends, ALICE, [], useStore.getState().entries.pix!);
    expect(activity.unopenedPix).toHaveLength(0);
    expect(activityPreview(activity, ALICE)).toEqual({ text: 'Pix viewed', highlight: false });
    // Once a received pix is seen, the chat timeline hides it immediately even before the 15m sweep.
    expect(chatTimeline([], useStore.getState().entries.pix!, CONV, ALICE)).toEqual([]);
  });

  it('re-projects viewedAt in memory on markSeen without re-reading directMessage or pix from SQLite', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();
    await Obscura.entryPut(
      'directMessage', 'dm_mem', JSON.stringify({ conversationId: CONV, content: 'hi' }), 1_000, BOB.userId, 'd', null,
    );
    await loadEntries('directMessage');
    await loadEntries('pix');

    const callsBefore = bridge.__calls.length;
    await markSeen('directMessage', useStore.getState().entries.directMessage![0]);
    const recentCalls = bridge.__calls.slice(callsBefore);

    expect(useStore.getState().entries.directMessage?.[0].viewedAt).not.toBeNull();
    // Only `seen` is read from SQLite; `directMessage` and `pix` are updated in memory.
    expect(recentCalls.filter((c) => c === 'entryAll')).toHaveLength(1);
  });

  it('coalesces concurrent flushOutboxFromStore triggers and gates foreground outbox flush on connected state', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setFriends([BOB]);
    await loadSession();

    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');
    await expect(saveEntry('story', { content: 'once' })).rejects.toThrow('offline');
    expect(bridge.__sent).toHaveLength(0);

    // Foregrounding while disconnected drains/sweeps, but does NOT flush the outbox yet.
    useStore.setState({ connState: 'disconnected' });
    applyObscuraEvent({ type: 'appStateChanged', state: 'active' });
    await flush();
    expect(bridge.__sent).toHaveLength(0);

    // Concurrent outbox flushes coalesce so the entry is sent once, not duplicated.
    await Promise.all([flushOutboxFromStore(), flushOutboxFromStore(), flushOutboxFromStore()]);
    expect(bridge.__sent.filter((s) => s.modelKey === 'story')).toHaveLength(1);
    warn.mockRestore();
  });

  it('sends sendTyping on non-empty input and stopTyping when cleared to empty', async () => {
    notifyTyping(BOB.userId, CONV, '', 'h');
    notifyTyping(BOB.userId, CONV, 'h', 'hi');
    notifyTyping(BOB.userId, CONV, 'hi', '');
    await flush();

    expect(bridge.__calls.filter((c) => c === 'sendTyping')).toHaveLength(2);
    expect(bridge.__calls.filter((c) => c === 'stopTyping')).toHaveLength(1);
  });
});
