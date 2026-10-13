import { putEntry } from '../entryStore';
import { PIX_MEDIA } from '../../native/__fixtures__/payloads';
import { drainInbox } from '../drainInbox';
import { writeEntry } from '../writeEntry';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';
import { withEntryLock } from '../entryLock';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';
const FRIENDS: Friend[] = [{ userId: BOB, username: 'bob', status: 'accepted' }];
const CONV = [SELF, BOB].sort().join('_');

describe('a local write racing an incoming drain', () => {
  it('does not revert a viewed-receipt written while a drain is in flight', async () => {
    await Obscura.entryPut('pix', 'p1', JSON.stringify({ conversationId: CONV, viewedAt: 0 }), 1_000, BOB, null);
    bridge.__deliverInbox({
      modelKey: 'pix', entryId: 'p1', sentAt: 3_000, senderDeviceId: 'device_peer',
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, viewedAt: 0 }),
    });

    const draining = drainInbox();
    const writing = writeEntry({
      model: 'pix', id: 'p1',
      data: { ...PIX_MEDIA, conversationId: CONV, viewedAt: 42 },
      selfUserId: SELF, myDeviceId: DEVICE, friends: FRIENDS,
    });
    await Promise.all([draining, writing]);

    const stored = await Obscura.entryAll('pix');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data).viewedAt).toBe(42);
  });

  /** The same, with the write starting first — the interleaving must be safe in both directions. */
  it('does not lose the write when it starts before the drain', async () => {
    await Obscura.entryPut('pix', 'p1', JSON.stringify({ viewedAt: 0 }), 1_000, BOB, null);
    bridge.__deliverInbox({
      modelKey: 'pix', entryId: 'p1', sentAt: 3_000, senderDeviceId: 'device_peer',
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, viewedAt: 0 }),
    });

    const writing = writeEntry({
      model: 'pix', id: 'p1', data: { ...PIX_MEDIA, conversationId: CONV, viewedAt: 42 },
      selfUserId: SELF, myDeviceId: DEVICE, friends: FRIENDS,
    });
    const draining = drainInbox();
    await Promise.all([writing, draining]);

    expect(JSON.parse((await Obscura.entryAll('pix'))[0].data).viewedAt).toBe(42);
  });

  /**
   * A local write must beat a peer row that is ahead of our clock. A stored `sentAt` can be up to
   * 60 s in the future, and without the step-past the write wins locally and loses everywhere else.
   */
  it('wins against a stored entry whose timestamp is in the future', async () => {
    const future = Date.now() + 45_000;
    await putEntry('pix', { id: 'p1', sentAt: future, authorUserId: BOB, authorDeviceId: BOB, data: { viewedAt: 0 } });

    await writeEntry({
      model: 'pix', id: 'p1', data: { ...PIX_MEDIA, conversationId: CONV, viewedAt: 42 },
      selfUserId: SELF, myDeviceId: DEVICE, friends: FRIENDS,
    });

    const stored = (await Obscura.entryAll('pix'))[0];
    expect(JSON.parse(stored.data).viewedAt).toBe(42);
    expect(stored.sentAt).toBeGreaterThan(future);
    // And the peer is told the same timestamp we stored, or they would reject what we just applied.
    expect(bridge.__sent[0].sentAt).toBe(stored.sentAt);
  });
});

describe('the lock itself', () => {
  it('runs work in the order it was enqueued', async () => {
    const order: number[] = [];
    await Promise.all([
      withEntryLock(async () => { await Promise.resolve(); order.push(1); }),
      withEntryLock(async () => { order.push(2); }),
      withEntryLock(async () => { order.push(3); }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  /** One failed write must not wedge every write after it. */
  it('keeps running after a rejection', async () => {
    const failed = withEntryLock(() => Promise.reject(new Error('nope')));
    await expect(failed).rejects.toThrow('nope');

    await expect(withEntryLock(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
