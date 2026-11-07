import {
  useStore, loadSession, refreshMessages, flushOutboxFromStore, sweepAndRefresh,
  applyObscuraEvent, addFriend, acceptFriend, removeFriend, markSeen, resetSession,
} from '../store';
import { logIn, linkThisDevice } from '../login';
import { sendCapture, type Capture } from '../sendMedia';
import { activityPreview, chatTimeline, friendActivities } from '../../domain/chats';
import type { Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const ALICE = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB: Friend = { userId: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'accepted' };

beforeEach(() => {
  resetSession();
  bridge.__authenticate({ userId: ALICE, username: 'alice', deviceId: DEVICE });
});

afterEach(() => {
  jest.restoreAllMocks();
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
    await Promise.resolve();
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

describe('Scenario 2: offline capture -> reconnect sync -> peer seen receipt -> expiry sweep refresh', () => {
  it('reports undelivered capture targets, deletes temp files, updates activity on seen receipt, and refreshes slices touched by sweepExpired', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setFriends([BOB]);
    await loadSession();

    // 1. Alice captures a photo while Bob is unreachable.
    bridge.__setUnreachable([BOB.userId]);
    const capture: Capture = { path: '/fake/shot.jpg', mediaType: 'photo', caption: 'secret', displayDuration: 5 };
    const undelivered = await sendCapture(capture, [BOB], true);

    expect(undelivered).toEqual(['bob', 'My story']);
    expect(bridge.deletedFiles).toContain('/fake/shot.jpg');
    expect(useStore.getState().messages).toHaveLength(1);
    expect(useStore.getState().stories).toHaveLength(1);

    const [pixEntry] = useStore.getState().messages;
    if (pixEntry.kind !== 'pix') throw new Error('Expected pix entry');
    let [bobActivity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix delivered', highlight: false });

    // 2. Network reconnects: store triggers flushOutbox and sweepExpired.
    bridge.__setUnreachable([]);
    bridge.__calls.length = 0;
    await applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });

    expect(bridge.__calls).toContain('flushOutbox');
    expect(bridge.__calls).toContain('sweepExpired');

    // 3. Bob opens the pix and his seen receipt arrives for Alice.
    const viewedAt = pixEntry.sentAt + 5_000;
    bridge.__deliverSeen({
      entryId: pixEntry.id,
      senderUserId: BOB.userId,
      viewedAt,
      sentAt: viewedAt,
    });
    await applyObscuraEvent({ type: 'messageReceived', model: 'seen' });

    expect(useStore.getState().messages[0].viewedAt).toBe(viewedAt);
    [bobActivity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix opened', highlight: false });

    // 4. Native sweep erases the expired pix and reports 'pix' as touched; sweepAndRefresh reloads the slice.
    bridge.messages = [];
    bridge.__setSweepResult(['pix']);
    await sweepAndRefresh();

    expect(useStore.getState().messages).toEqual([]);
    warn.mockRestore();
  });
});

describe('Scenario 3: incoming pix viewed locally + concurrent refresh & chat sending', () => {
  it('coalesces concurrent refreshMessages calls so in-flight arrivals are not lost', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    const firstRefresh = refreshMessages();
    bridge.__deliverMessage({
      id: 'dm_race',
      peerUserId: BOB.userId,
      authorUserId: BOB.userId,
      content: 'arrived during refresh',
    });
    await Promise.all([firstRefresh, refreshMessages()]);

    expect(useStore.getState().messages.map((m) => m.id)).toEqual(['dm_race']);
  });

  it('highlights an incoming unopened pix in activityPreview until markSeen marks it viewed', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    bridge.__deliverPix({
      id: 'pix_in_1',
      peerUserId: BOB.userId,
      authorUserId: BOB.userId,
      attachment: { id: 'att_1', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
      caption: 'look!',
      displayDuration: 5,
    });
    await applyObscuraEvent({ type: 'messageReceived', model: 'pix' });

    let [activity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activity.unopenedPix).toHaveLength(1);
    expect(activityPreview(activity, ALICE)).toEqual({ text: 'New pix · tap to view', highlight: true });
    expect(chatTimeline(useStore.getState().messages, BOB.userId, ALICE)).toEqual([
      { kind: 'pix', id: 'pix_in_1', sentAt: expect.any(Number), authorUserId: BOB.userId, status: 'received_new' },
    ]);

    await markSeen(activity.unopenedPix[0].id);

    [activity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activity.unopenedPix).toHaveLength(0);
    expect(activityPreview(activity, ALICE)).toEqual({ text: 'Pix viewed', highlight: false });
    // Once a received pix is seen, the chat timeline hides it immediately even before the 15m sweep.
    expect(chatTimeline(useStore.getState().messages, BOB.userId, ALICE)).toEqual([]);
  });

  it('coalesces concurrent flushOutboxFromStore triggers and gates foreground outbox flush on connected state', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    // Foregrounding while disconnected refreshes/sweeps, but does NOT flush the outbox yet.
    useStore.setState({ connState: 'disconnected' });
    bridge.__calls.length = 0;
    await applyObscuraEvent({ type: 'appStateChanged', state: 'active' });
    expect(bridge.__calls).not.toContain('flushOutbox');

    // Concurrent outbox flushes coalesce into at most one in-flight + one trailing call.
    bridge.__calls.length = 0;
    await Promise.all([flushOutboxFromStore(), flushOutboxFromStore(), flushOutboxFromStore()]);
    expect(bridge.__calls.filter((c) => c === 'flushOutbox')).toHaveLength(2);
  });
});

