import { putEntry } from '../entryStore';
import { PIX_MEDIA } from '../../native/__fixtures__/payloads';
import { drainInbox, drainInboxFully } from '../drainInbox';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

/**
 * The drain, end to end against the in-memory kit double.
 *
 * `drain.test.ts` covers the decision; this covers the **effects and their order**, which is the
 * part that can destroy a message. An inbox row is the only copy — the kit already acked, so the
 * server deleted its own — so "consume" is irreversible and everything here is about what happens
 * before it.
 */

const bridge = getFakeBridge();

// UUID-shaped, because a conversation id splits on `_` and these ids go into one.
const SELF = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CONV = [SELF, PEER].sort().join('_');

/**
 * The drain authorizes every row against the authenticated session, so there has to be one. Without
 * it `getUserId()` resolves `null` and the drain correctly refuses to store anything.
 */
beforeEach(() => {
  bridge.__authenticate({ userId: SELF });
});

/** A well-formed inbound row from the peer, in a conversation with this user. */
function deliver(over: Partial<Parameters<typeof bridge.__deliverInbox>[0]> = {}) {
  const { payload, ...rest } = over as { payload?: string } & Record<string, unknown>;
  return bridge.__deliverInbox({
    senderUserId: PEER,
    payload: payload ?? JSON.stringify({ conversationId: CONV, content: 'hello' }),
    ...rest,
  });
}

describe('draining', () => {
  it('reads only the entries its batch names, never a whole model', async () => {
    await Obscura.entryPut('directMessage', 'dm_old', '{}', 1, 'd', null);
    deliver({ modelKey: 'directMessage', entryId: 'dm_1' });
    const start = bridge.__calls.length;

    await drainInbox();

    expect(bridge.__calls.slice(start)).not.toContain('entryAll');
    expect(bridge.__calls.slice(start)).toContain('entryGet');
  });

  it('writes the entry and consumes the row', async () => {
    deliver({ modelKey: 'directMessage', entryId: 'dm_1' });

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 1, consumed: 1, discarded: 0, touched: ['directMessage'] });
    expect(await Obscura.inboxDepth()).toBe(0);
    const stored = await Obscura.entryAll('directMessage');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data))
      .toEqual({ conversationId: CONV, content: 'hello', _authorUserId: PEER });
  });

  it('preserves the authenticated sender device as the stored tie-break', async () => {
    deliver({
      modelKey: 'pix', entryId: 'p_1', senderDeviceId: 'device_authenticated',
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, viewedAt: 0 }),
    });

    await drainInbox();

    expect((await Obscura.entryAll('pix'))[0].authorDeviceId).toBe('device_authenticated');
  });

  it('does nothing when the inbox is empty', async () => {
    const result = await drainInbox();

    expect(result).toEqual({ written: 0, consumed: 0, discarded: 0, touched: [] });
    expect(bridge.__calls).not.toContain('entryPut');
  });

  /**
   * Without an identity there is nothing to authorize against, and the safe answer is to store
   * nothing rather than to discard everything — the rows stay put and the next trigger retries,
   * which is exactly what `peek` being side-effect free buys.
   */
  it('refuses to drain before the session identity is available', async () => {
    await Obscura.logout();
    bridge.__deliverInbox({ payload: JSON.stringify({ conversationId: CONV }) });

    const result = await drainInbox();

    expect(result).toEqual({ written: 0, consumed: 0, discarded: 0, touched: [] });
    expect(await Obscura.inboxDepth()).toBe(1);
  });
});

describe('the effect ORDER', () => {
  /**
   * **The load-bearing test.** The row must be written before it is consumed, because consuming
   * destroys the only copy. Asserted on the actual call sequence rather than on the end state,
   * because the end state looks identical either way — and looks identical right up until a write
   * fails.
   */
  it('writes the entry BEFORE consuming the row', async () => {
    deliver({ entryId: 'dm_1' });

    await drainInbox();

    const put = bridge.__calls.indexOf('entryPut');
    const consume = bridge.__calls.indexOf('inboxConsume');
    expect(put).toBeGreaterThanOrEqual(0);
    expect(consume).toBeGreaterThan(put);
  });

  /**
   * Assert the same ordering in a mixed consume/discard batch.
   */
  it('still sees the real consume when the batch also discards', async () => {
    deliver({ entryId: 'dm_1' });
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });

    await drainInbox();

    expect(bridge.__calls.indexOf('inboxConsume')).toBeGreaterThan(bridge.__calls.indexOf('entryPut'));
    expect(bridge.__calls).toContain('inboxDiscard');
  });

  /**
   * The consequence of that order, and the reason it is worth enforcing: if the write fails, the row
   * is still in the inbox, so the next drain reprocesses it. Nothing is lost. That is safe only
   * because `peek` is side-effect free and `merge` is idempotent.
   */
  it('leaves the row in the inbox when the write fails', async () => {
    deliver({ entryId: 'dm_1' });
    bridge.__failNext('entryPut', 'ENTRY_PUT_ERROR', 'disk full');

    await expect(drainInbox()).rejects.toThrow();

    expect(await Obscura.inboxDepth()).toBe(1);
    expect(bridge.__calls).not.toContain('inboxConsume');
  });

  it('recovers on the next drain after a failed write', async () => {
    deliver({ entryId: 'dm_1' });
    bridge.__failNext('entryPut', 'ENTRY_PUT_ERROR');
    await expect(drainInbox()).rejects.toThrow();

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 1, consumed: 1 });
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(await Obscura.entryAll('directMessage')).toHaveLength(1);
  });
});

describe('rows the app cannot process', () => {
  /** An unprocessable row is discarded, not skipped; a skipped row would block the queue forever. */
  it('discards an unknown kind and empties the inbox', async () => {
    bridge.__deliverInbox({ kind: 'SOMETHING_NEWER', modelKey: null, entryId: null, payload: 'opaque' });

    const result = await drainInbox();

    expect(result.discarded).toBe(1);
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(bridge.__discarded).toEqual([{ ids: [expect.any(Number)], reason: 'unknown-kind' }]);
  });

  it('discards with a reason the kit can log, grouped by reason', async () => {
    bridge.__deliverInbox({ kind: 'UNKNOWN_A', modelKey: null, entryId: null, payload: 'x' });
    bridge.__deliverInbox({ kind: 'UNKNOWN_B', modelKey: null, entryId: null, payload: 'y' });
    bridge.__deliverInbox({ modelKey: 'notAModel', payload: '{}' });

    await drainInbox();

    const reasons = bridge.__discarded.map((d) => d.reason).sort();
    expect(reasons).toEqual(['unknown-kind', 'unknown-model']);
    // Two unknown-kind rows, one call.
    expect(bridge.__discarded.find((d) => d.reason === 'unknown-kind')?.ids).toHaveLength(2);
  });

  /** A discard is data loss, so the app logs it too, not only the kit. */
  it('surfaces the discard app-side, not only to the kit', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });

    await drainInbox();

    expect(warn.mock.calls.flat().join('\n')).toContain('unknown-kind');
    warn.mockRestore();
  });

  /**
   * Delivery is not authorization. A stranger's `profile` written to MY id would win the REPLACE
   * merge with a higher `sentAt`.
   */
  it('discards an entry the sender was not entitled to write', async () => {
    bridge.__deliverInbox({
      modelKey: 'profile', entryId: `profile_${SELF}`,
      senderUserId: '99999999-9999-4999-8999-999999999999',
      payload: JSON.stringify({ displayName: 'owned' }),
    });

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 0, discarded: 1 });
    expect(await Obscura.entryAll('profile')).toEqual([]);
    expect(bridge.__discarded[0].reason).toBe('unauthorized-sender');
  });

  it('processes the good rows in a batch that also contains bad ones', async () => {
    deliver({ entryId: 'ok_1' });
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });
    deliver({ entryId: 'ok_2' });

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 2, consumed: 2, discarded: 1 });
    expect(await Obscura.inboxDepth()).toBe(0);
  });
});

describe('merging against what is already stored', () => {
  it('does not overwrite a newer entry with an older redelivered one', async () => {
    await putEntry('pix', {
      id: 'p', sentAt: 9_000, authorUserId: PEER, authorDeviceId: 'device_a', data: { conversationId: CONV, v: 'newer' },
    });
    deliver({
      modelKey: 'pix', entryId: 'p', sentAt: 1_000,
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, v: 'older' }),
    });

    const result = await drainInbox();

    // Consumed — it WAS processed, and the right outcome was "keep what we have".
    expect(result).toMatchObject({ written: 0, consumed: 1 });
    expect(JSON.parse((await Obscura.entryAll('pix'))[0].data).v).toBe('newer');
  });

  it('keeps the first write for an APPEND model when a duplicate arrives', async () => {
    await putEntry('directMessage', {
      id: 'dm', sentAt: 1_000, authorUserId: PEER, authorDeviceId: 'd', data: { conversationId: CONV, content: 'first' },
    });
    deliver({
      entryId: 'dm', sentAt: 9_000,
      payload: JSON.stringify({ conversationId: CONV, content: 'second' }),
    });

    await drainInbox();

    expect(JSON.parse((await Obscura.entryAll('directMessage'))[0].data).content).toBe('first');
  });

  /**
   * Draining twice must reach the same state, because a crash between peek and consume means the
   * same rows come back. This is the property that makes write-before-consume safe rather than
   * merely careful.
   */
  it('is idempotent across a re-drain of the same rows', async () => {
    const row = {
      modelKey: 'pix' as const, entryId: 'p', sentAt: 5_000,
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, v: 'once' }),
    };
    deliver(row);
    await drainInbox();

    // The kit redelivers (a DIFFERENT envelope, since the deduped one is gone) and the app
    // reprocesses.
    deliver(row);
    await drainInbox();

    const stored = await Obscura.entryAll('pix');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data).v).toBe('once');
  });

  /** Pix and messages are append-only, so the other participant cannot change what this side sent. */
  it('ignores the other participant rewriting a pix or message', async () => {
    await Obscura.entryPut(
      'pix', 'p', JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, caption: 'mine', _authorUserId: SELF }),
      1_000, 'device_mine', null,
    );
    await Obscura.entryPut(
      'directMessage', 'dm', JSON.stringify({ conversationId: CONV, content: 'what I said', _authorUserId: SELF }),
      1_000, 'device_mine', null,
    );
    deliver({
      modelKey: 'pix', entryId: 'p', sentAt: 9_000,
      payload: JSON.stringify({ ...PIX_MEDIA, conversationId: CONV, caption: 'rewritten' }),
    });
    deliver({
      modelKey: 'directMessage', entryId: 'dm', sentAt: 9_000,
      payload: JSON.stringify({ conversationId: CONV, content: 'words put in my mouth' }),
    });

    await drainInbox();

    expect(JSON.parse((await Obscura.entryAll('pix'))[0].data).caption).toBe('mine');
    expect(JSON.parse((await Obscura.entryAll('directMessage'))[0].data).content).toBe('what I said');
  });
});

describe('the inbox dedupes on envelopeId, as both kits do', () => {
  /** Persist-then-ack makes redelivery routine; the envelope id keeps it to one row. */
  it('does not create a second row for a redelivered envelope', async () => {
    const first = deliver({ entryId: 'dm_1' });
    deliver({ envelopeId: first.envelopeId, entryId: 'dm_1' });

    expect(await Obscura.inboxDepth()).toBe(1);
  });
});

describe('draining fully', () => {
  it('keeps going until the inbox is empty', async () => {
    for (let i = 0; i < 12; i += 1) {
      deliver({ entryId: `dm_${i}` });
    }

    const result = await drainInboxFully(5);

    expect(result.consumed).toBe(12);
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(await Obscura.entryAll('directMessage')).toHaveLength(12);
  });

  it('reports every model it touched, once', async () => {
    deliver({ modelKey: 'directMessage', entryId: 'a' });
    deliver({ modelKey: 'story', entryId: 'b', payload: '{"content":"hi"}' });
    deliver({ modelKey: 'directMessage', entryId: 'c' });

    const result = await drainInboxFully(1);

    expect(result.touched.sort()).toEqual(['directMessage', 'story']);
  });

  it('terminates on an inbox of only undrainable rows', async () => {
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });

    const result = await drainInboxFully(5);

    expect(result.discarded).toBe(1);
    expect(await Obscura.inboxDepth()).toBe(0);
  });

  /**
   * The batch bound is a termination guard, and hitting it is worth logging — but only when rows are
   * actually left behind. Testing `i === maxBatches - 1` inside the loop fired whenever the LAST
   * permitted batch made progress, so a run that emptied the inbox on its final batch reported a
   * failure. Any row count that is an exact multiple of the batch size hits that.
   */
  it('does not report a failure when the last permitted batch empties the inbox', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 4; i += 1) deliver({ entryId: `dm_${i}` });

    const result = await drainInboxFully(2, 2);

    expect(result.consumed).toBe(4);
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('maxBatches');
    warn.mockRestore();
  });

  it('reports a failure when the bound is reached with rows still waiting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 6; i += 1) deliver({ entryId: `dm_${i}` });

    await drainInboxFully(2, 2);

    expect(await Obscura.inboxDepth()).toBe(2);
    expect(warn.mock.calls.flat().join('\n')).toContain('maxBatches');
    warn.mockRestore();
  });
});
