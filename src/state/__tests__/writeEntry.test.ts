import { PIX_MEDIA } from '../../native/__fixtures__/payloads';
import { writeEntry, newEntryId, flushOutbox } from '../writeEntry';
import { DirectRoutingUnresolved } from '../../domain/audience';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

/**
 * The write path. Tests application-owned id generation, storage, audience resolution, and fan-out.
 */

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const FRIENDS: Friend[] = [
  { userId: BOB, username: 'bob', status: 'accepted' },
  { userId: '44444444-4444-4444-8444-444444444444', username: 'carol', status: 'accepted' },
];

function args(model: string, data: Record<string, unknown>, id?: string) {
  return { model, id, data, selfUserId: SELF, myDeviceId: DEVICE, friends: FRIENDS };
}

describe('storing and sending', () => {
  it('stores locally and sends to the resolved audience', async () => {
    const convId = [SELF, BOB].sort().join('_');

    const id = await writeEntry(args('directMessage', { conversationId: convId, content: 'hi' }));

    const stored = await Obscura.entryAll('directMessage');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(id);
    // `_authorUserId` is stamped by `writeEntry`, not supplied by the caller.
    expect(JSON.parse(stored[0].data))
      .toEqual({ conversationId: convId, content: 'hi', _authorUserId: SELF });

    expect(bridge.__sent).toHaveLength(1);
    expect(bridge.__sent[0].recipientUserIds).toEqual([BOB]);
    expect(bridge.__sent[0].modelKey).toBe('directMessage');
  });

  /** `send` produces no inbox row for the sender, so the local write is the only copy. */
  it('is the only thing that stores the sender copy — nothing loops back', async () => {
    await writeEntry(args('story', { content: 'mine' }));

    expect(await Obscura.entryAll('story')).toHaveLength(1);
    expect(await Obscura.inboxDepth()).toBe(0);
  });

  it('records the authoring device, which is the merge tie-break', async () => {
    await writeEntry(args('profile', { displayName: 'me' }, 'profile_1'));

    expect((await Obscura.entryAll('profile'))[0].authorDeviceId).toBe(DEVICE);
  });

  it('keeps local attribution out of the wire payload', async () => {
    const data = { content: 'sunset 🌅', meta: { x: 0.5, tags: ['a', 'b'] } };

    await writeEntry(args('story', data));

    const stored = await Obscura.entryAll('story');
    expect(JSON.parse(stored[0].data)).toEqual({ ...data, _authorUserId: SELF });
    expect(JSON.parse(bridge.__sent[0].payloadJson)).toEqual(data);
  });

});

describe('the effect ORDER', () => {
  it('writes locally BEFORE sending', async () => {
    await writeEntry(args('story', { content: 'x' }));

    expect(bridge.__calls.indexOf('entryPut')).toBeLessThan(bridge.__calls.indexOf('sendEntry'));
  });

  it('keeps the local entry when the send fails, but still reports the failure', async () => {
    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');

    await expect(writeEntry(args('story', { content: 'x' }))).rejects.toThrow('offline');

    expect(await Obscura.entryAll('story')).toHaveLength(1);
  });
});

describe('field validation', () => {
  it('refuses data that does not match the schema, and writes nothing', async () => {
    const convId = [SELF, BOB].sort().join('_');

    await expect(writeEntry(args('directMessage', { conversationId: convId, content: 42 })))
      .rejects.toThrow('invalid fields content');

    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });
});

describe('audience failures', () => {
  /**
   * **Nothing is stored and nothing is sent.** A local row the user can see but that reached nobody
   * is worse than a refusal — they would believe it was delivered.
   */
  it('stores nothing when the audience cannot be resolved', async () => {
    // A three-party conversation id: the LEAK GUARD case.
    const bad = args('directMessage', { conversationId: 'a_b_c', content: 'x' });

    await expect(writeEntry(bad)).rejects.toThrow(DirectRoutingUnresolved);

    expect(await Obscura.entryAll('directMessage')).toEqual([]);
    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });

  it('refuses rather than broadcasting when a 1:1 audience is missing', async () => {
    await expect(writeEntry(args('directMessage', { content: 'no conversation id' })))
      .rejects.toThrow(DirectRoutingUnresolved);

    expect(bridge.__sent).toEqual([]);
  });

  it('resolves pix by conversation, and drops a participant who is not a friend', async () => {
    await writeEntry(args('pix', { ...PIX_MEDIA, conversationId: [SELF, STRANGER].sort().join('_') }));

    // Stored — it is the user's own entry — but sent to nobody but their own devices.
    expect(await Obscura.entryAll('pix')).toHaveLength(1);
    expect(bridge.__sent[0].recipientUserIds).toEqual([]);
  });

  it('refuses a conversation this user is not part of', async () => {
    const theirs = [BOB, '44444444-4444-4444-8444-444444444444'].sort().join('_');

    await expect(writeEntry(args('pix', { ...PIX_MEDIA, conversationId: theirs })))
      .rejects.toThrow(DirectRoutingUnresolved);

    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });

  it('sends to a conversation participant who IS a friend', async () => {
    await writeEntry(args('pix', { ...PIX_MEDIA, conversationId: [SELF, BOB].sort().join('_') }));

    expect(bridge.__sent[0].recipientUserIds).toEqual([BOB]);
  });

  /** A model name that is not in `schema.ts` must not fall through to "everyone". */
  it('refuses a model the schema does not declare, rather than broadcasting it', async () => {
    // One character off `directMessage`.
    await expect(writeEntry(args('directMessages', { conversationId: `${SELF}_${BOB}`, content: 'private' })))
      .rejects.toThrow(DirectRoutingUnresolved);

    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });
});

describe('attribution', () => {
  it('always records this user as the author, whatever the data claims', async () => {
    const convId = [SELF, BOB].sort().join('_');

    await writeEntry(args('pix', { ...PIX_MEDIA, conversationId: convId, _authorUserId: BOB }));

    expect(JSON.parse((await Obscura.entryAll('pix'))[0].data)._authorUserId).toBe(SELF);
  });
});

describe('the outbox', () => {
  /**
   * `writeEntry` keeps a local row when a send reaches nobody. The outbox mark
   * makes later reconnect, foreground, cold-start, and wake syncs retry it.
   */
  it('marks an entry whose send reached nobody, and retries it on the next flush', async () => {
    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');
    await expect(writeEntry(args('story', { content: 'stranded' }))).rejects.toThrow('offline');
    expect(bridge.__sent).toEqual([]);

    const delivered = await flushOutbox({ selfUserId: SELF, friends: FRIENDS });

    expect(delivered).toBe(1);
    expect(bridge.__sent).toHaveLength(1);
    expect(JSON.parse(bridge.__sent[0].payloadJson).content).toBe('stranded');
  });

  /** Delivery bookkeeping is a local sidecar. A peer never sees it, and success clears it. */
  it('never puts the mark on the wire, and clears it once delivered', async () => {
    bridge.__failNext('sendEntry', 'SEND_FAILED');
    await expect(writeEntry(args('story', { content: 'x' }))).rejects.toThrow();
    expect(JSON.parse((await Obscura.entryAll('story'))[0].localMetadata ?? '{}').undelivered).toBe(true);

    await flushOutbox({ selfUserId: SELF, friends: FRIENDS });

    expect(JSON.parse(bridge.__sent[0].payloadJson)._authorUserId).toBeUndefined();
    expect((await Obscura.entryAll('story'))[0].localMetadata).toBeNull();
  });

  /** Still offline: the mark stays, so the trigger after this one tries again. */
  it('keeps the mark when the retry also fails', async () => {
    bridge.__failNext('sendEntry', 'SEND_FAILED');
    await expect(writeEntry(args('story', { content: 'x' }))).rejects.toThrow();

    bridge.__failNext('sendEntry', 'SEND_FAILED');
    expect(await flushOutbox({ selfUserId: SELF, friends: FRIENDS })).toBe(0);

    expect(JSON.parse((await Obscura.entryAll('story'))[0].localMetadata ?? '{}').undelivered).toBe(true);
  });

  /** The kit reports per device and never throws because nobody received it; the app decides. */
  it('treats a report in which no recipient accepted as a failed send', async () => {
    bridge.__setUnreachable([BOB, '44444444-4444-4444-8444-444444444444']);
    await expect(writeEntry(args('story', { content: 'x' }))).rejects.toMatchObject({ code: 'SEND_FAILED' });
    expect(JSON.parse((await Obscura.entryAll('story'))[0].localMetadata ?? '{}').undelivered).toBe(true);

    expect(await flushOutbox({ selfUserId: SELF, friends: FRIENDS })).toBe(0);

    bridge.__setUnreachable([]);
    expect(await flushOutbox({ selfUserId: SELF, friends: FRIENDS })).toBe(1);
    expect((await Obscura.entryAll('story'))[0].localMetadata).toBeNull();
  });

  it('treats a delivery to some recipients as a success', async () => {
    bridge.__setUnreachable([BOB]);
    await writeEntry(args('story', { content: 'x' }));
    expect((await Obscura.entryAll('story'))[0].localMetadata).toBeNull();
  });

  it('does nothing when everything was delivered', async () => {
    await writeEntry(args('story', { content: 'fine' }));
    const sentBefore = bridge.__sent.length;

    expect(await flushOutbox({ selfUserId: SELF, friends: FRIENDS })).toBe(0);
    expect(bridge.__sent).toHaveLength(sentBefore);
  });

  it('does not resurrect an entry a newer write has replaced', async () => {
    const id = 'profile_x';
    bridge.__failNext('sendEntry', 'SEND_FAILED');
    await expect(writeEntry(args('profile', { displayName: 'old' }, id))).rejects.toThrow();

    await writeEntry(args('profile', { displayName: 'new' }, id));

    expect(JSON.parse((await Obscura.entryAll('profile'))[0].data).displayName).toBe('new');
    expect((await Obscura.entryAll('profile'))[0].localMetadata).toBeNull();
  });
});

describe('entry ids', () => {
  /**
   * Randomness is not decoration: APPEND dedupes by id, so two devices creating an entry in the same
   * millisecond must not collide — one would silently discard the other's message.
   */
  it('are unique even within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newEntryId('story')));

    expect(ids.size).toBe(500);
  });

  it('are namespaced by model, so a human reading the store can tell them apart', () => {
    expect(newEntryId('story')).toMatch(/^story_\d+_[a-z0-9]+$/);
  });
});
