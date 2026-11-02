import {
  useStore, loadSession, refreshMessages, flushOutboxFromStore, sweepAndRefresh,
  applyObscuraEvent, addFriend, acceptFriend, removeFriend, markSeen, resetSession,
} from '../store';
import { notifyTyping, sendChatMessage } from '../chat';
import { logIn, linkThisDevice } from '../login';
import { sendCapture, type Capture } from '../sendMedia';
import { activityPreview, chatTimeline, friendActivities } from '../../domain/chats';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { EXPIRE_AFTER_MS } from '../../native/__fixtures__/FakeObscuraBridge';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const ALICE = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB: Friend = { userId: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'accepted' };

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

    // 1. Alice captures a photo while Bob is unreachable.
    bridge.__setUnreachable([BOB.userId]);
    const capture: Capture = { path: '/fake/shot.jpg', mediaType: 'photo', caption: 'secret', displayDuration: 5 };
    const undelivered = await sendCapture(capture, [BOB], true);

    expect(undelivered).toEqual(['bob', 'My story']);
    expect(bridge.__calls).toContain('deleteFile');
    expect(useStore.getState().messages).toHaveLength(1);
    expect(useStore.getState().stories).toHaveLength(1);

    const [pixEntry] = useStore.getState().messages;
    let [bobActivity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix delivered', highlight: false });

    // 2. Network reconnects: outbox flushes both the pix and the story to Bob.
    bridge.__setUnreachable([]);
    applyObscuraEvent({ type: 'connectionChanged', state: 'connected' });
    await flush();

    expect(bridge.__sent.filter((s) => s.modelKey === 'pix' && s.recipientUserIds.includes(BOB.userId))).toHaveLength(1);
    expect(bridge.__sent.filter((s) => s.modelKey === 'story' && s.recipientUserIds.includes(BOB.userId))).toHaveLength(1);

    // 3. Bob opens the pix and his seen receipt arrives for Alice.
    const viewedAt = pixEntry.sentAt + 5_000;
    bridge.__deliverSeen({
      entryId: pixEntry.id,
      senderUserId: BOB.userId,
      viewedAt,
      sentAt: viewedAt,
    });
    applyObscuraEvent({ type: 'messageReceived', model: 'seen' });
    await flush();

    expect(useStore.getState().messages[0].viewedAt).toBe(viewedAt);
    [bobActivity] = friendActivities(useStore.getState().friends, ALICE, useStore.getState().messages);
    expect(activityPreview(bobActivity, ALICE)).toEqual({ text: 'Pix opened', highlight: false });

    // 4. 15 minutes pass after viewing: the sweep erases the pix and its decrypted media,
    //    and records a tombstone that blocks any replayed copy.
    bridge.__advanceTime(EXPIRE_AFTER_MS + 10_000);
    await sweepAndRefresh();

    expect(useStore.getState().messages).toEqual([]);
    expect(bridge.__purged).toContain(pixEntry.mediaRef);

    // 5. A replayed delivery for the erased pix is ignored and never resurrected.
    bridge.__deliverPix({
      id: pixEntry.id,
      peerUserId: BOB.userId,
      authorUserId: ALICE,
      sentAt: pixEntry.sentAt,
      mediaRef: pixEntry.mediaRef ?? 'att_1',
    });
    applyObscuraEvent({ type: 'messageReceived', model: 'pix' });
    await flush();
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
      mediaRef: 'att_1',
      contentKey: 'k',
      nonce: 'n',
      mediaType: 'photo',
      caption: 'look!',
      displayDuration: 5,
    });
    applyObscuraEvent({ type: 'messageReceived', model: 'pix' });
    await flush();

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

  it('stops typing, sends a chat message, and refreshes messages', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    await sendChatMessage(BOB.userId, 'hello bob');

    expect(bridge.__calls).toContain('stopTyping');
    expect(bridge.__calls).toContain('sendMessage');
    expect(useStore.getState().messages).toEqual([
      expect.objectContaining({ peerUserId: BOB.userId, kind: 'message', content: 'hello bob' }),
    ]);
  });

  it('coalesces concurrent flushOutboxFromStore triggers and gates foreground outbox flush on connected state', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setFriends([BOB]);
    await loadSession();

    bridge.__failNext('postStory', 'SEND_FAILED', 'offline');
    await expect(Obscura.postStory('once', null, null, null, null, null)).rejects.toThrow('offline');
    expect(bridge.__sent).toHaveLength(0);

    // Foregrounding while disconnected refreshes/sweeps, but does NOT flush the outbox yet.
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
    notifyTyping(BOB.userId, '', 'h');
    notifyTyping(BOB.userId, 'h', 'hi');
    notifyTyping(BOB.userId, 'hi', '');
    await flush();

    expect(bridge.__calls.filter((c) => c === 'sendTyping')).toHaveLength(2);
    expect(bridge.__calls.filter((c) => c === 'stopTyping')).toHaveLength(1);
  });
});
