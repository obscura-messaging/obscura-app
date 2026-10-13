import { mergeAll, merge, type Entry } from '../merge';

/**
 * Properties the merge fixtures cannot express.
 *
 * These exist because mutation-testing the vector suite found a hole: changing APPEND from
 * "first write wins" to "last write wins" passed all 13 vector-driven tests. The vectors' GSet
 * idempotence case uses a duplicate id carrying IDENTICAL data — because `DOMAIN_CONTRACT.md` requires
 * GSet entries are immutable by construction — so the two behaviours are indistinguishable there.
 *
 * A hostile peer can replay an existing id with different content, so
 * first-wins is pinned here explicitly.
 */

const entry = (over: Partial<Entry> & { id: string }): Entry => ({
  sentAt: 1,
  authorUserId: 'uA',
  authorDeviceId: 'devA',
  data: {},
  ...over,
});

describe('APPEND', () => {
  it('keeps the FIRST write when a peer replays an id with different content', () => {
    // Not covered by merge.json: its duplicate carries identical data, so first-vs-last is
    // unobservable there. A peer that replays an established id with new content must not be able
    // to rewrite it — the same class of defect as a peer renaming itself in the friend graph.
    const state = mergeAll('APPEND', [
      entry({ id: 'm1', sentAt: 1, authorDeviceId: 'devA', data: { text: 'original' } }),
      entry({ id: 'm1', sentAt: 99, authorDeviceId: 'devEvil', data: { text: 'rewritten' } }),
    ]);

    expect(state.get('m1')!.data).toEqual({ text: 'original' });
    expect(state.get('m1')!.authorDeviceId).toBe('devA');
  });

  it('is idempotent under replay — the inbox drain depends on this', () => {
    // peek -> process -> consume: an app that crashes before consuming reprocesses those rows.
    const ops = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    const once = mergeAll('APPEND', ops);
    const twice = merge('APPEND', once, ops);
    expect([...twice.entries()]).toEqual([...once.entries()]);
  });
});

describe('REPLACE', () => {
  it('keeps the higher sentAt regardless of arrival order', () => {
    const older = entry({ id: 'p', sentAt: 10, data: { v: 'old' } });
    const newer = entry({ id: 'p', sentAt: 20, data: { v: 'new' } });
    expect(mergeAll('REPLACE', [older, newer]).get('p')!.data).toEqual({ v: 'new' });
    expect(mergeAll('REPLACE', [newer, older]).get('p')!.data).toEqual({ v: 'new' });
  });

  it('breaks an equal-timestamp tie by the higher authorDeviceId, both ways round', () => {
    const a = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'a' } });
    const b = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devB', data: { v: 'b' } });
    expect(mergeAll('REPLACE', [a, b]).get('p')!.data).toEqual({ v: 'b' });
    expect(mergeAll('REPLACE', [b, a]).get('p')!.data).toEqual({ v: 'b' });
  });

  it('treats an identical (sentAt, authorDeviceId) as the same logical write', () => {
    const first = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'first' } });
    const dup = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'second' } });
    // Idempotent: keep what we have rather than churn on a redelivery.
    expect(mergeAll('REPLACE', [first, dup]).get('p')!.data).toEqual({ v: 'first' });
  });

  it('is idempotent under replay', () => {
    const ops = [
      entry({ id: 'p', sentAt: 1, data: { v: 1 } }),
      entry({ id: 'p', sentAt: 2, data: { v: 2 } }),
    ];
    const once = mergeAll('REPLACE', ops);
    const twice = merge('REPLACE', once, ops);
    expect([...twice.entries()]).toEqual([...once.entries()]);
  });
});

describe('convergence', () => {
  // The property the whole design rests on: two devices that receive the same writes in different
  // orders must reach the same state. Single-device testing cannot see a violation, which is why
  // DOMAIN_CONTRACT calls the tie-break mandatory.
  const ops: Entry[] = [
    entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'a' } }),
    entry({ id: 'p', sentAt: 5, authorDeviceId: 'devB', data: { v: 'b' } }),
    entry({ id: 'p', sentAt: 4, authorDeviceId: 'devC', data: { v: 'c' } }),
    entry({ id: 'q', sentAt: 9, authorDeviceId: 'devA', data: { v: 'q' } }),
  ];

  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1
      ? [xs]
      : xs.flatMap((x, i) =>
          permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
        );

  it('REPLACE converges across every arrival order', () => {
    const results = permutations(ops).map((order) =>
      JSON.stringify([...mergeAll('REPLACE', order).entries()].sort()),
    );
    expect(new Set(results).size).toBe(1);
  });

  it('APPEND converges when a repeated id carries identical content — its real invariant', () => {
    // Entry ids are `model_timestamp_random`, so a given id is written once and any duplicate is a
    // redelivery of the same bytes. Under that invariant first-wins is convergent.
    const dup = entry({ id: 'm1', sentAt: 3, authorDeviceId: 'devA', data: { text: 'hello' } });
    const set = [entry({ id: 'm0', data: { text: 'zero' } }), dup, { ...dup }, { ...dup }];
    const results = permutations(set).map((order) =>
      JSON.stringify([...mergeAll('APPEND', order).entries()].sort()),
    );
    expect(new Set(results).size).toBe(1);
  });

  it('APPEND is deliberately order-dependent when a peer replays an id with DIFFERENT content', () => {
    // A DECISION, not a defect, and it is written down here so it is not "fixed" later.
    //
    // Only a buggy or hostile peer can produce one id with two contents. Given that, there are two
    // options and no third: first-wins (this) keeps what we already had and may leave two devices
    // disagreeing about the attacker's entry; last-wins would converge, at the cost of letting any
    // peer overwrite an established entry by replaying its id.
    //
    // We take non-convergence over silent overwrite. Divergence about a hostile write is visible
    // and recoverable; a rewritten message is neither.
    const conflicting = [
      entry({ id: 'm1', sentAt: 1, authorDeviceId: 'devA', data: { text: 'original' } }),
      entry({ id: 'm1', sentAt: 2, authorDeviceId: 'devEvil', data: { text: 'rewritten' } }),
    ];
    const outcomes = new Set(
      permutations(conflicting).map((order) =>
        JSON.stringify([...mergeAll('APPEND', order).entries()]),
      ),
    );
    expect(outcomes.size).toBe(2);
    // ...and whichever order the honest write arrives in, it is never silently replaced afterwards.
    expect(mergeAll('APPEND', conflicting).get('m1')!.data).toEqual({ text: 'original' });
  });
});
