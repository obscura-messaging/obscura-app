import { merge, type Entry } from '../merge';

const entry = (over: Partial<Entry> & { id: string }): Entry => ({
  sentAt: 1,
  authorUserId: 'uA',
  authorDeviceId: 'devA',
  data: {},
  ...over,
});

describe('APPEND', () => {
  it('keeps the FIRST write when a peer replays an id with different content', () => {
    const state = merge('APPEND', new Map(), [
      entry({ id: 'm1', sentAt: 1, authorDeviceId: 'devA', data: { text: 'original' } }),
      entry({ id: 'm1', sentAt: 99, authorDeviceId: 'devEvil', data: { text: 'rewritten' } }),
    ]);

    expect(state.get('m1')!.data).toEqual({ text: 'original' });
    expect(state.get('m1')!.authorDeviceId).toBe('devA');
  });

  it('is idempotent under replay — the inbox drain depends on this', () => {
    // peek -> process -> consume: an app that crashes before consuming reprocesses those rows.
    const ops = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    const once = merge('APPEND', new Map(), ops);
    const twice = merge('APPEND', once, ops);
    expect([...twice.entries()]).toEqual([...once.entries()]);
  });
});

describe('REPLACE', () => {
  it('keeps the higher sentAt regardless of arrival order', () => {
    const older = entry({ id: 'p', sentAt: 10, data: { v: 'old' } });
    const newer = entry({ id: 'p', sentAt: 20, data: { v: 'new' } });
    expect(merge('REPLACE', new Map(), [older, newer]).get('p')!.data).toEqual({ v: 'new' });
    expect(merge('REPLACE', new Map(), [newer, older]).get('p')!.data).toEqual({ v: 'new' });
  });

  it('breaks an equal-timestamp tie by the higher authorDeviceId, both ways round', () => {
    const a = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'a' } });
    const b = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devB', data: { v: 'b' } });
    expect(merge('REPLACE', new Map(), [a, b]).get('p')!.data).toEqual({ v: 'b' });
    expect(merge('REPLACE', new Map(), [b, a]).get('p')!.data).toEqual({ v: 'b' });
  });

  it('treats an identical (sentAt, authorDeviceId) as the same logical write', () => {
    const first = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'first' } });
    const dup = entry({ id: 'p', sentAt: 5, authorDeviceId: 'devA', data: { v: 'second' } });
    // Idempotent: keep what we have rather than churn on a redelivery.
    expect(merge('REPLACE', new Map(), [first, dup]).get('p')!.data).toEqual({ v: 'first' });
  });

  it('is idempotent under replay', () => {
    const ops = [
      entry({ id: 'p', sentAt: 1, data: { v: 1 } }),
      entry({ id: 'p', sentAt: 2, data: { v: 2 } }),
    ];
    const once = merge('REPLACE', new Map(), ops);
    const twice = merge('REPLACE', once, ops);
    expect([...twice.entries()]).toEqual([...once.entries()]);
  });
});

describe('convergence', () => {
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
      JSON.stringify([...merge('REPLACE', new Map(), order).entries()].sort()),
    );
    expect(new Set(results).size).toBe(1);
  });

  it('APPEND converges when a repeated id carries identical content — its real invariant', () => {
    // Entry ids are `model_timestamp_random`, so a given id is written once and any duplicate is a
    // redelivery of the same bytes. Under that invariant first-wins is convergent.
    const dup = entry({ id: 'm1', sentAt: 3, authorDeviceId: 'devA', data: { text: 'hello' } });
    const set = [entry({ id: 'm0', data: { text: 'zero' } }), dup, { ...dup }, { ...dup }];
    const results = permutations(set).map((order) =>
      JSON.stringify([...merge('APPEND', new Map(), order).entries()].sort()),
    );
    expect(new Set(results).size).toBe(1);
  });

  it('APPEND is deliberately order-dependent when a peer replays an id with DIFFERENT content', () => {
    // Chosen: a replayed id must not rewrite an established entry, even at the cost of convergence.
    const conflicting = [
      entry({ id: 'm1', sentAt: 1, authorDeviceId: 'devA', data: { text: 'original' } }),
      entry({ id: 'm1', sentAt: 2, authorDeviceId: 'devEvil', data: { text: 'rewritten' } }),
    ];
    const outcomes = new Set(
      permutations(conflicting).map((order) =>
        JSON.stringify([...merge('APPEND', new Map(), order).entries()]),
      ),
    );
    expect(outcomes.size).toBe(2);
    // ...and whichever order the honest write arrives in, it is never silently replaced afterwards.
    expect(merge('APPEND', new Map(), conflicting).get('m1')!.data).toEqual({ text: 'original' });
  });
});
