import { Obscura, onObscuraEvent, type ObscuraEvent } from '../ObscuraModule';
import { EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS } from '../__fixtures__/FakeObscuraBridge';
import { getFakeBridge } from '../__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

describe('the double is actually installed', () => {
  it('resolves real values', async () => {
    await Obscura.sendMessage('u_bob', 'hi');

    const stored = await Obscura.getMessages();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ peerUserId: 'u_bob', kind: 'message', content: 'hi' });
    expect(bridge.__calls).toContain('sendMessage');
  });

  it('delivers events', () => {
    const seen: ObscuraEvent[] = [];
    const off = onObscuraEvent((e) => seen.push(e));

    bridge.__setConnectionState('connected');

    expect(seen).toEqual([{ type: 'connectionChanged', state: 'connected' }]);
    off();
  });

  it('stops delivering after unsubscribe, so a test cannot leak into the next', () => {
    const seen: ObscuraEvent[] = [];
    const off = onObscuraEvent((e) => seen.push(e));

    // One delivery first, so the assertion below cannot pass vacuously.
    bridge.__setConnectionState('connecting');
    expect(seen).toHaveLength(1);

    off();
    bridge.__setConnectionState('connected');

    expect(seen).toHaveLength(1);
    expect(bridge.__listenerCount()).toBe(0);
  });
});

describe('typed domain operations', () => {
  it('stores and orders messages and pix, and applies seen receipts', async () => {
    const msgId = await Obscura.sendMessage('u_bob', 'hello');
    const pixId = await Obscura.sendPix('u_bob', 'att_1', 'key', 'nonce', 'photo', 'look', null, 5);

    let items = await Obscura.getMessages();
    expect(items.map((i) => [i.id, i.kind, i.viewedAt])).toEqual([
      [msgId, 'message', null],
      [pixId, 'pix', null],
    ]);

    // A seen receipt from the peer marks the pix viewed, capped at the receipt's sentAt.
    bridge.__deliverSeen({ entryId: pixId, senderUserId: 'u_bob', viewedAt: 9_999_999_999_999, sentAt: 1_700_000_005_000 });
    items = await Obscura.getMessages();
    expect(items.find((i) => i.id === pixId)?.viewedAt).toBe(1_700_000_005_000);
  });

  it('keeps the first write for APPEND models (messages, pix, stories)', async () => {
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: 'u_bob', authorUserId: 'u_bob', content: 'first', sentAt: 1_000 });
    bridge.__deliverMessage({ id: 'dm_1', peerUserId: 'u_bob', authorUserId: 'u_bob', content: 'second', sentAt: 9_000 });

    const [msg] = await Obscura.getMessages();
    if (msg.kind !== 'message') throw new Error('Expected a message');
    expect(msg.content).toBe('first');
    expect(msg.sentAt).toBe(1_000);
  });

  it('round-trips unicode stories and captionMeta, and hides stories older than 24h', async () => {
    const captionMeta = {
      style: 'bold' as const,
      x: 0.5,
      y: 0.5,
      rot: 0,
      scale: 1,
      color: '#fff',
      font: 0,
    };
    await Obscura.postStory('sunset 🌅', 'att_1', 'k', 'n', 'photo', captionMeta);

    const [story] = await Obscura.getStories();
    expect(story).toMatchObject({
      content: 'sunset 🌅',
      attachment: { id: 'att_1', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
      captionMeta,
    });

    bridge.__advanceTime(STORY_MAX_AGE_MS + 1);
    expect(await Obscura.getStories()).toEqual([]);
  });

  it('merges profiles with REPLACE ordered by (updatedAt, authorDeviceId)', async () => {
    bridge.__deliverProfile({ userId: 'u_bob', authorDeviceId: 'device_a', updatedAt: 1_000, displayName: 'Old', bio: '' });
    bridge.__deliverProfile({ userId: 'u_bob', authorDeviceId: 'device_z', updatedAt: 1_000, displayName: 'TieWinner', bio: 'bio' });
    bridge.__deliverProfile({ userId: 'u_bob', authorDeviceId: 'device_a', updatedAt: 900, displayName: 'Stale', bio: '' });

    const [profile] = await Obscura.getProfiles();
    expect(profile).toMatchObject({ userId: 'u_bob', displayName: 'TieWinner', bio: 'bio', updatedAt: 1_000 });
  });

  it('queues undelivered writes in the outbox and flushes them once reachable', async () => {
    bridge.__setFriends([{ userId: 'u_bob', username: 'bob', status: 'accepted' }]);
    bridge.__setUnreachable(['u_bob']);

    await expect(Obscura.sendMessage('u_bob', 'queued')).rejects.toMatchObject({ code: 'SEND_FAILED' });
    expect(await Obscura.getMessages()).toHaveLength(1);
    expect(bridge.__sent).toEqual([]);

    bridge.__setUnreachable([]);
    expect(await Obscura.flushOutbox()).toBe(1);
    expect(bridge.__sent).toHaveLength(1);
    expect(bridge.__sent[0]).toMatchObject({ modelKey: 'directMessage', recipientUserIds: ['u_bob'] });
  });

  it('sweeps expired seen items after 15m, unseen items after 30d, purges media, and blocks replays via tombstones', async () => {
    const incomingPix = bridge.__deliverPix({
      id: 'pix_1',
      peerUserId: 'u_bob',
      authorUserId: 'u_bob',
      mediaRef: 'att_purge',
      caption: 'view once',
    });
    await Obscura.markSeen(incomingPix.id);

    bridge.__advanceTime(EXPIRE_AFTER_MS + 1);
    const touched = await Obscura.sweepExpired();
    expect(touched).toContain('pix');
    expect(await Obscura.getMessages()).toEqual([]);
    expect(bridge.__purged).toContain('att_purge');

    // Replaying the erased pix is blocked by its tombstone.
    bridge.__deliverPix({ id: 'pix_1', peerUserId: 'u_bob', authorUserId: 'u_bob', mediaRef: 'att_purge' });
    expect(await Obscura.getMessages()).toEqual([]);

    // Unseen messages expire after the 30d ceiling.
    await Obscura.sendMessage('u_bob', 'unseen');
    bridge.__advanceTime(MAX_AGE_MS + 1);
    expect(await Obscura.sweepExpired()).toContain('directMessage');
    expect(await Obscura.getMessages()).toEqual([]);
  });
});

describe('failures', () => {
  /**
   * Without an injectable failure every `.catch(...)` in the app is dead code under test, because
   * every bridge call resolves.
   */
  it('rejects with a code the app can branch on', async () => {
    bridge.__failNext('sendMessage', 'SEND_FAILED', 'reached nobody');

    await expect(Obscura.sendMessage('u_bob', 'hi'))
      .rejects.toMatchObject({ code: 'SEND_FAILED' });
  });

  it('fails only the next call, so a suite is not poisoned by one injection', async () => {
    bridge.__failNext('postStory', 'STORAGE_ERROR');

    await expect(Obscura.postStory('a', null, null, null, null, null)).rejects.toThrow();
    await expect(Obscura.postStory('b', null, null, null, null, null)).resolves.toEqual(expect.any(String));
  });
});

describe('multi-device', () => {
  it('waits only on a link that beginLink opened, and only once', async () => {
    await expect(Obscura.completeLink()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    await Obscura.beginLink('alice', 'password-1234');
    const waiting = Obscura.completeLink();
    await expect(Obscura.completeLink()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    bridge.__approvePendingLink();
    await waiting;
    expect(await Obscura.isPrimary()).toBe(false);
  });

  it('refuses primary-only calls on a linked device', async () => {
    bridge.__authenticate();
    bridge.__setPrimary(false);

    for (const call of [
      () => Obscura.approveLink('code'),
      () => Obscura.addFriendByCode('u:name'),
      () => Obscura.acceptFriend('u'),
      () => Obscura.removeFriend('u'),
      () => Obscura.unlinkDevice('device_other'),
    ]) await expect(call()).rejects.toMatchObject({ code: 'NOT_PRIMARY' });
  });

  it('lets the primary unlink another device but not itself', async () => {
    bridge.__authenticate();
    bridge.__setDevices([
      { deviceId: 'device_self', name: 'Phone', isPrimary: true, isThisDevice: true },
      { deviceId: 'device_other', name: null, isPrimary: false, isThisDevice: false },
    ]);

    await expect(Obscura.unlinkDevice('device_self')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await Obscura.unlinkDevice('device_other');

    expect((await Obscura.getDevices()).map((d) => d.deviceId)).toEqual(['device_self']);
  });
});
