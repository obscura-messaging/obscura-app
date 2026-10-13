import { planDrain, type ModelRules } from '../drain';
import type { InboxRow } from '../../native/ObscuraModule';
import type { Entry } from '../merge';

/**
 * The drain plan (`docs/DOMAIN_CONTRACT.md`): not losing a row (it is the only copy) and not
 * believing one (authorization and attribution come from the envelope, never the payload).
 */

const SELF = 'uMe';
const PEER = 'uPeer';
const STRANGER = 'uStranger';
const CONV = [SELF, PEER].sort().join('_');

const models = new Map<string, ModelRules>([
  ['directMessage', { merge: 'APPEND', fields: { content: 'string' }, conversationField: 'conversationId' }],
  ['story', { merge: 'APPEND', fields: {} }],
  ['pix', { merge: 'APPEND', fields: {}, conversationField: 'conversationId' }],
  ['profile', { merge: 'REPLACE', fields: {}, ownerIdPrefix: 'profile_' }],
  // A conversation-scoped REPLACE model, for the merge mechanics below.
  ['note', { merge: 'REPLACE', fields: {}, conversationField: 'conversationId' }],
]);

let nextId = 1;
function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: nextId++,
    kind: 'APP_ENTRY',
    modelKey: 'directMessage',
    entryId: `entry_${nextId}`,
    sentAt: 1_000,
    senderUserId: PEER,
    senderDeviceId: 'device_peer',
    payload: JSON.stringify({ content: 'hi', conversationId: CONV }),
    ...over,
  };
}

beforeEach(() => {
  nextId = 1;
});

const empty = new Map<string, ReadonlyMap<string, Entry>>();

describe('the happy path', () => {
  it('merges a row and consumes it', () => {
    const r = row({ entryId: 'dm_1' });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.consume).toEqual([r.id]);
    expect(plan.discard).toEqual([]);
    expect(plan.writes.get('directMessage')).toEqual([
      {
        id: 'dm_1',
        sentAt: 1_000,
        authorUserId: PEER,
        authorDeviceId: 'device_peer',
        data: { content: 'hi', conversationId: CONV },
      },
    ]);
  });

  it('carries the authenticated sender device as the merge tie-break, not anything from the payload', () => {
    const r = row({
      entryId: 'p_1',
      modelKey: 'pix',
      senderDeviceId: 'device_authenticated',
      payload: JSON.stringify({ conversationId: CONV, authorDeviceId: 'device_CLAIMED_BY_PEER' }),
    });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.writes.get('pix')?.[0].authorDeviceId).toBe('device_authenticated');
  });
});

describe('attribution — who an entry is from', () => {
  /** A stranger's `story` claiming to be Alice is attributed to the server-stamped sender. */
  it('overwrites a payload-claimed author with the authenticated sender', () => {
    const r = row({
      modelKey: 'story',
      entryId: 's_1',
      senderUserId: STRANGER,
      payload: JSON.stringify({ content: 'x', _authorUserId: 'uAlice', authorUsername: 'alice' }),
    });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.writes.get('story')?.[0].authorUserId).toBe(STRANGER);
  });

  /** A pix is append-only: the other participant cannot change one this device already holds. */
  it('ignores a second write to a stored entry by the other participant', () => {
    const mine: Entry = {
      id: 'p', sentAt: 1_000, authorUserId: SELF, authorDeviceId: 'device_mine',
      data: { conversationId: CONV, caption: 'mine' },
    };
    const state = new Map([['pix', new Map([['p', mine]])]]);
    const rewrite = row({
      modelKey: 'pix', entryId: 'p', sentAt: 9_000, senderUserId: PEER,
      payload: JSON.stringify({ conversationId: CONV, caption: 'rewritten' }),
    });

    const plan = planDrain([rewrite], models, state, SELF);

    expect(plan.consume).toEqual([rewrite.id]);
    expect(plan.writes.get('pix') ?? []).toEqual([]);
  });
});

describe('authorization — who may write what', () => {
  /**
   * **Attack B.** `profile` is REPLACE and its id is `profile_<userId>`, which anybody can guess. A
   * stranger's write with a higher `sentAt` took over the row `ProfileScreen` reads — and the save
   * button then re-broadcast their text to all my friends under my name.
   */
  it('refuses a profile written to somebody else\'s id', () => {
    const r = row({
      modelKey: 'profile', entryId: `profile_${SELF}`, senderUserId: STRANGER,
      payload: JSON.stringify({ displayName: 'owned' }),
    });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unauthorized-sender' }]);
    expect(plan.writes.size).toBe(0);
  });

  it('accepts a profile written to the sender\'s own id', () => {
    const r = row({
      modelKey: 'profile', entryId: `profile_${PEER}`, senderUserId: PEER,
      payload: JSON.stringify({ displayName: 'peer' }),
    });

    expect(planDrain([r], models, empty, SELF).consume).toEqual([r.id]);
  });

  /** A stranger writing into my conversation with somebody else. */
  it('refuses an entry whose conversation does not name the sender', () => {
    const r = row({
      entryId: 'dm_x', senderUserId: STRANGER,
      payload: JSON.stringify({ content: 'from "peer"', conversationId: CONV }),
    });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unauthorized-sender' }]);
  });

  /** A conversation between two other people is not this device's to store. */
  it('refuses an entry for a conversation this user is not in', () => {
    const r = row({
      entryId: 'dm_y',
      payload: JSON.stringify({ content: 'x', conversationId: [PEER, STRANGER].sort().join('_') }),
    });

    expect(planDrain([r], models, empty, SELF).discard).toEqual([
      { id: r.id, reason: 'unauthorized-sender' },
    ]);
  });

  it('refuses a conversation-scoped entry with a missing or non-canonical conversation id', () => {
    const missing = row({ payload: JSON.stringify({ content: 'x' }) });
    const threeParty = row({
      payload: JSON.stringify({ content: 'x', conversationId: `${SELF}_${PEER}_${STRANGER}` }),
    });

    expect(planDrain([missing, threeParty], models, empty, SELF).discard).toEqual([
      { id: missing.id, reason: 'unauthorized-sender' },
      { id: threeParty.id, reason: 'unauthorized-sender' },
    ]);
  });

  /**
   * The other half of the send side's guard. DOMAIN_CONTRACT: a reversed form MUST be rejected
   * "rather than guessing an audience" — and on this side, guessing files a peer's entry under a
   * conversation id no participant would ever compute, so the screens never show it and the row is
   * stored anyway.
   */
  it('refuses a conversation-scoped entry whose id is reversed', () => {
    const r = row({
      entryId: 'dm_reversed',
      payload: JSON.stringify({ content: 'x', conversationId: CONV.split('_').reverse().join('_') }),
    });

    expect(planDrain([r], models, empty, SELF).discard).toEqual([
      { id: r.id, reason: 'unauthorized-sender' },
    ]);
  });

  /** Self-sync: my own other device is a legitimate writer for both sides of the conversation. */
  it('accepts an entry synced from this user\'s own other device', () => {
    const r = row({ entryId: 'dm_self', senderUserId: SELF, senderDeviceId: 'device_other' });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.consume).toEqual([r.id]);
    expect(plan.writes.get('directMessage')?.[0].authorUserId).toBe(SELF);
  });

  /**
   * `story` has neither rule, and that is a deliberate limit rather than an omission: a story
   * carries nothing that binds it to an author, so there is no claim to check — only an
   * attribution to stamp. Friendship is NOT required, because a discard is permanent and the
   * friend graph updates over a different message than the entry does.
   */
  it('accepts a story from anybody, attributed to them', () => {
    const r = row({
      modelKey: 'story', entryId: 's_2', senderUserId: STRANGER,
      payload: JSON.stringify({ content: 'spam' }),
    });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.consume).toEqual([r.id]);
    expect(plan.writes.get('story')?.[0].authorUserId).toBe(STRANGER);
  });
});

describe('rows the app cannot process', () => {
  /** The kit inboxes unknown arms; the app cannot read them either, so it discards them. */
  it('discards an unknown kind rather than skipping it', () => {
    const r = row({ kind: 'UNKNOWN', modelKey: null, entryId: null });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unknown-kind' }]);
    expect(plan.consume).toEqual([]);
  });

  it('discards a model this version of the app does not know', () => {
    const r = row({ modelKey: 'somethingNewer' });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unknown-model' }]);
  });

  it('discards a payload that is not a JSON object', () => {
    const notObject = planDrain([row({ payload: '"just a string"' })], models, empty, SELF);
    const notJSON = planDrain([row({ payload: '{{{' })], models, empty, SELF);

    expect(notObject.discard[0].reason).toBe('unparsable-payload');
    expect(notJSON.discard[0].reason).toBe('unparsable-payload');
  });

  /**
   * `senderDeviceId` is the REPLACE tie-break. Without it two devices receiving the same writes in
   * different orders converge to different states.
   */
  it('discards a row with no authenticated sender device', () => {
    const r = row({ senderDeviceId: null });

    const plan = planDrain([r], models, empty, SELF);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'missing-fields' }]);
  });

  /** No authenticated user means nothing to authorize against and nobody to attribute the entry to. */
  it('discards a row with no authenticated sender user', () => {
    const r = row({ senderUserId: '' });

    expect(planDrain([r], models, empty, SELF).discard).toEqual([
      { id: r.id, reason: 'missing-fields' },
    ]);
  });

  /**
   * Every row is consumed or discarded. There is no skip cursor, so a row that is neither stays at
   * the head of the queue forever.
   */
  it('accounts for every row — nothing is silently skipped', () => {
    const rows = [
      row({ entryId: 'ok_1' }),
      row({ kind: 'UNKNOWN' }),
      row({ modelKey: 'unknownModel' }),
      row({ payload: 'not json' }),
      row({ senderDeviceId: null }),
      row({ senderUserId: STRANGER }),
      row({ entryId: 'ok_2' }),
    ];

    const plan = planDrain(rows, models, empty, SELF);

    const accounted = [...plan.consume, ...plan.discard.map((d) => d.id)].sort((a, b) => a - b);
    expect(accounted).toEqual(rows.map((r) => r.id));
  });
});

describe('merging within a batch', () => {
  /**
   * Two rows touching one entry must resolve against **each other**, not just against stored state.
   * Otherwise the second silently wins on arrival order rather than on the merge rule — the
   * divergence `DOMAIN_CONTRACT.md` describes, reachable inside a single `peek`.
   */
  it('resolves two rows for the same entry by the rule, not by arrival order', () => {
    const older = row({
      modelKey: 'note', entryId: 'p', sentAt: 1_000,
      payload: JSON.stringify({ v: 'old', conversationId: CONV }),
    });
    const newer = row({
      modelKey: 'note', entryId: 'p', sentAt: 9_000,
      payload: JSON.stringify({ v: 'new', conversationId: CONV }),
    });

    const forward = planDrain([older, newer], models, empty, SELF);
    const reverse = planDrain([newer, older], models, empty, SELF);

    expect(forward.writes.get('note')).toHaveLength(1);
    expect(forward.writes.get('note')?.[0].data.v).toBe('new');
    expect(reverse.writes.get('note')?.[0].data.v).toBe('new');
  });

  /**
   * A losing write must not be queued: `entryPut` is a blind upsert and would overwrite the winner.
   * The row is still consumed.
   */
  it('consumes but does not write a row that loses the merge', () => {
    const stored: Entry = {
      id: 'p', sentAt: 9_000, authorUserId: PEER, authorDeviceId: 'device_x',
      data: { v: 'stored', conversationId: CONV },
    };
    const state = new Map([['note', new Map([['p', stored]])]]);
    const loser = row({
      modelKey: 'note', entryId: 'p', sentAt: 1_000,
      payload: JSON.stringify({ v: 'older', conversationId: CONV }),
    });

    const plan = planDrain([loser], models, state, SELF);

    expect(plan.consume).toEqual([loser.id]);
    expect(plan.writes.get('note') ?? []).toEqual([]);
  });

  /** APPEND is first-write-wins, so a redelivered duplicate must not overwrite the original. */
  it('keeps the first write for an APPEND model', () => {
    const first: Entry = {
      id: 'dm', sentAt: 1_000, authorUserId: PEER, authorDeviceId: 'd',
      data: { content: 'first', conversationId: CONV },
    };
    const state = new Map([['directMessage', new Map([['dm', first]])]]);
    const dup = row({
      entryId: 'dm', sentAt: 9_000,
      payload: JSON.stringify({ content: 'second', conversationId: CONV }),
    });

    const plan = planDrain([dup], models, state, SELF);

    expect(plan.consume).toEqual([dup.id]);
    expect(plan.writes.get('directMessage') ?? []).toEqual([]);
  });

  /**
   * Reprocessing must converge, because `peek` is side-effect free and a crash between peek and
   * consume means the same rows come back. That is the crash-safety property the design trades for.
   */
  it('is idempotent — draining the same batch twice reaches the same state', () => {
    const rows = [
      row({
        modelKey: 'note', entryId: 'p', sentAt: 1_000,
        payload: JSON.stringify({ v: 'a', conversationId: CONV }),
      }),
      row({
        modelKey: 'note', entryId: 'p', sentAt: 9_000,
        payload: JSON.stringify({ v: 'b', conversationId: CONV }),
      }),
    ];

    const first = planDrain(rows, models, empty, SELF);
    const afterFirst = new Map([
      ['note', new Map((first.writes.get('note') ?? []).map((e) => [e.id, e] as const))],
    ]);
    const second = planDrain(rows, models, afterFirst, SELF);

    expect(first.writes.get('note')?.[0].data.v).toBe('b');
    // Second pass changes nothing — the winner already won.
    expect(second.writes.get('note') ?? []).toEqual([]);
    expect(second.consume).toEqual(rows.map((r) => r.id));
  });

  it('queues one write per entry id, not one per row', () => {
    const rows = [1, 2, 3].map((v) => row({
      modelKey: 'note', entryId: 'p', sentAt: v * 1_000,
      payload: JSON.stringify({ v, conversationId: CONV }),
    }));

    const plan = planDrain(rows, models, empty, SELF);

    expect(plan.writes.get('note')).toHaveLength(1);
    expect(plan.writes.get('note')?.[0].data.v).toBe(3);
    expect(plan.consume).toHaveLength(3);
  });
});

describe('the empty case', () => {
  it('plans nothing for no rows', () => {
    const plan = planDrain([], models, empty, SELF);

    expect(plan.consume).toEqual([]);
    expect(plan.discard).toEqual([]);
    expect(plan.writes.size).toBe(0);
  });
});

describe('field validation', () => {
  it('discards an entry whose fields do not match the declared types', () => {
    const wrongType = row({ payload: JSON.stringify({ content: { not: 'a string' }, conversationId: CONV }) });
    const missing = row({ payload: JSON.stringify({ conversationId: CONV }) });

    const plan = planDrain([wrongType, missing], models, empty, SELF);

    expect(plan.discard).toEqual([
      { id: wrongType.id, reason: 'invalid-fields' },
      { id: missing.id, reason: 'invalid-fields' },
    ]);
    expect(plan.writes.size).toBe(0);
  });
});

describe('erased entries', () => {
  it('consumes a write for an erased entry without storing it', () => {
    const r = row({ modelKey: 'directMessage', entryId: 'dm_gone' });

    const plan = planDrain([r], models, empty, SELF, new Set(['directMessage:dm_gone']));

    expect(plan.consume).toEqual([r.id]);
    expect(plan.writes.get('directMessage') ?? []).toEqual([]);
  });

  it('only skips the erased model, not the same id in another model', () => {
    const r = row({ modelKey: 'pix', entryId: 'dm_gone' });

    const plan = planDrain([r], models, empty, SELF, new Set(['directMessage:dm_gone']));

    expect(plan.writes.get('pix')?.map((e) => e.id)).toEqual(['dm_gone']);
  });
});
