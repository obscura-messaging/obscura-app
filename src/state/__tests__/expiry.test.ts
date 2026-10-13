import { sweepExpired } from '../expiry';
import { drainInbox } from '../drainInbox';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';
import { PIX_MEDIA } from '../../native/__fixtures__/payloads';
import { ERASED_MODEL, EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS } from '../../domain/expiry';
import { SEEN_MODEL, seenEntryId } from '../../domain/seen';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const CONV = [SELF, PEER].sort().join('_');
const NOW = 100 * MAX_AGE_MS;
const LONG_AGO = NOW - EXPIRE_AFTER_MS - 1;

beforeEach(() => {
  bridge.__authenticate({ userId: SELF });
});

/** A message SELF sent at `sentAt`. */
function putMessage(id: string, sentAt = NOW - 1_000) {
  return Obscura.entryPut(
    'directMessage', id, JSON.stringify({ conversationId: CONV, content: id, _authorUserId: SELF }), sentAt, 'd',
  );
}

/** PEER's receipt for one of SELF's entries. */
function seenByPeer(model: string, id: string, viewedAt: number, author = PEER) {
  return Obscura.entryPut(
    SEEN_MODEL, seenEntryId(model, id),
    JSON.stringify({ conversationId: CONV, viewedAt, _authorUserId: author }), viewedAt, 'd_peer',
  );
}

async function ids(model: string): Promise<string[]> {
  return (await Obscura.entryAll(model)).map((e) => e.id).sort();
}

describe('sweepExpired', () => {
  it('erases entries seen more than EXPIRE_AFTER_MS ago with their receipts, and keeps the rest', async () => {
    await putMessage('dm_expired');
    await seenByPeer('directMessage', 'dm_expired', LONG_AGO);
    await putMessage('dm_recent');
    await seenByPeer('directMessage', 'dm_recent', NOW - 1_000);
    await putMessage('dm_unseen');

    expect(await sweepExpired(NOW)).toEqual(['directMessage']);

    expect(await ids('directMessage')).toEqual(['dm_recent', 'dm_unseen']);
    expect(await ids(SEEN_MODEL)).toEqual([seenEntryId('directMessage', 'dm_recent')]);
    expect(await ids(ERASED_MODEL)).toEqual([
      'directMessage:dm_expired',
      `${SEEN_MODEL}:${seenEntryId('directMessage', 'dm_expired')}`,
    ].sort());
  });

  it('erases each model in one call, after every erased marker is written', async () => {
    for (const id of ['a', 'b', 'c']) {
      await putMessage(id);
      await seenByPeer('directMessage', id, LONG_AGO);
    }
    const start = bridge.__calls.length;

    await sweepExpired(NOW);

    const calls = bridge.__calls.slice(start).filter((c) => c === 'entryPut' || c === 'entryErase');
    expect(calls).toEqual([...Array(6).fill('entryPut'), 'entryErase', 'entryErase']);
    expect(await ids('directMessage')).toEqual([]);
    expect(await ids(SEEN_MODEL)).toEqual([]);
  });

  it('erases an unseen entry once it is MAX_AGE_MS old', async () => {
    await putMessage('dm_old', NOW - MAX_AGE_MS);
    await putMessage('dm_new', NOW - MAX_AGE_MS + 1);

    await sweepExpired(NOW);

    expect(await ids('directMessage')).toEqual(['dm_new']);
  });

  it('purges the decrypted media of an expired pix', async () => {
    await Obscura.entryPut(
      'pix', 'pix_expired',
      JSON.stringify({ ...PIX_MEDIA, mediaRef: 'att_expired', conversationId: CONV, _authorUserId: SELF }), 1, 'd',
    );
    await seenByPeer('pix', 'pix_expired', LONG_AGO);
    await Obscura.entryPut(
      'pix', 'pix_unseen',
      JSON.stringify({ ...PIX_MEDIA, mediaRef: 'att_unseen', conversationId: CONV, _authorUserId: SELF }), NOW, 'd',
    );

    await sweepExpired(NOW);

    expect(await ids('pix')).toEqual(['pix_unseen']);
    expect(bridge.__purged).toEqual(['att_expired']);
  });

  it('erases a story STORY_MAX_AGE_MS after it was posted, with its media, and keeps newer ones', async () => {
    await Obscura.entryPut(
      'story', 'story_old',
      JSON.stringify({ ...PIX_MEDIA, mediaRef: 'att_story_old', content: '', _authorUserId: PEER }),
      NOW - STORY_MAX_AGE_MS, 'd_peer',
    );
    await Obscura.entryPut(
      'story', 'story_new',
      JSON.stringify({ content: 'text only', _authorUserId: PEER }), NOW - STORY_MAX_AGE_MS + 1, 'd_peer',
    );

    expect(await sweepExpired(NOW)).toEqual(['story']);

    expect(await ids('story')).toEqual(['story_new']);
    expect(bridge.__purged).toEqual(['att_story_old']);
    expect(await ids(ERASED_MODEL)).toEqual(['story:story_old']);
  });

  it('keeps an erased story erased when it is delivered again', async () => {
    await Obscura.entryPut(
      'story', 'story_1', JSON.stringify({ content: 'hi', _authorUserId: PEER }), NOW - STORY_MAX_AGE_MS, 'd_peer',
    );
    await sweepExpired(NOW);

    bridge.__deliverInbox({
      senderUserId: PEER, modelKey: 'story', entryId: 'story_1', sentAt: NOW - STORY_MAX_AGE_MS,
      payload: JSON.stringify({ content: 'hi' }),
    });

    expect(await drainInbox()).toMatchObject({ written: 0, consumed: 1 });
    expect(await ids('story')).toEqual([]);
  });

  it('does not expire an entry on a receipt its own author wrote', async () => {
    await putMessage('dm_1');
    await seenByPeer('directMessage', 'dm_1', LONG_AGO, SELF);

    expect(await sweepExpired(NOW)).toEqual([]);
    expect(await ids('directMessage')).toEqual(['dm_1']);
  });

  it('drops receipts whose entry never arrived once they are MAX_AGE_MS old, and prunes old markers', async () => {
    await seenByPeer('directMessage', 'never_arrived', NOW - MAX_AGE_MS);
    await seenByPeer('directMessage', 'still_coming', NOW - 1);
    await Obscura.entryPut(ERASED_MODEL, 'directMessage:old', '{}', NOW - MAX_AGE_MS, '');
    await Obscura.entryPut(ERASED_MODEL, 'directMessage:new', '{}', NOW - 1, '');

    await sweepExpired(NOW);

    expect(await ids(SEEN_MODEL)).toEqual([seenEntryId('directMessage', 'still_coming')]);
    expect(await ids(ERASED_MODEL)).toEqual(['directMessage:new']);
  });

  it('keeps an erased message and its receipt erased when they are delivered again', async () => {
    await putMessage('dm_1');
    await seenByPeer('directMessage', 'dm_1', LONG_AGO);
    await sweepExpired(NOW);

    bridge.__deliverInbox({
      senderUserId: PEER, modelKey: 'directMessage', entryId: 'dm_1', sentAt: NOW,
      payload: JSON.stringify({ conversationId: CONV, content: 'dm_1' }),
    });
    bridge.__deliverInbox({
      senderUserId: PEER, modelKey: SEEN_MODEL, entryId: seenEntryId('directMessage', 'dm_1'), sentAt: NOW,
      payload: JSON.stringify({ conversationId: CONV, viewedAt: NOW }),
    });

    expect(await drainInbox()).toMatchObject({ written: 0, consumed: 2 });
    expect(await ids('directMessage')).toEqual([]);
    expect(await ids(SEEN_MODEL)).toEqual([]);
  });
});
