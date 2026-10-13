import { Obscura } from '../native/ObscuraModule';
import { planDrain } from '../domain/drain';
import { erasedKey } from '../domain/expiry';
import type { Entry } from '../domain/merge';
import { modelRules } from '../models/schema';
import { groupBy } from '../utils/collections';
import { withEntryLock } from './entryLock';
import { putEntry, readEntriesById, readErasedKeys } from './entryStore';
import { logError } from '../utils/log';

const BATCH_SIZE = 50;

export interface DrainResult {
  written: number;
  consumed: number;
  discarded: number;
  /** Models whose entries changed. */
  touched: string[];
}

const nothingDrained = (): DrainResult => ({ written: 0, consumed: 0, discarded: 0, touched: [] });

/**
 * Drain one batch: peek, plan, write, then consume and discard. The inbox row is the only copy of a
 * message, so a failed write leaves it for the next drain; merge is idempotent.
 */
export function drainInbox(limit = BATCH_SIZE): Promise<DrainResult> {
  return withEntryLock(() => drainBatch(limit));
}

async function drainBatch(limit: number): Promise<DrainResult> {
  const rows = await Obscura.inboxPeek(limit);
  if (rows.length === 0) return nothingDrained();

  // Without an identity every conversation check would fail and discard real mail.
  const selfUserId = await Obscura.getUserId();
  if (!selfUserId) {
    logError('drain.noIdentity', new Error('inbox drain skipped: the session identity is not loaded'));
    return nothingDrained();
  }

  const rules = modelRules();
  const named = groupBy(rows.flatMap((r) =>
    r.modelKey !== null && r.entryId !== null && rules.has(r.modelKey)
      ? [[r.modelKey, r.entryId] as const]
      : []));
  const state = new Map<string, Map<string, Entry>>();
  for (const [model, ids] of named) {
    state.set(model, new Map((await readEntriesById(model, ids)).map((e) => [e.id, e])));
  }
  const erased = await readErasedKeys([...named].flatMap(([model, ids]) => ids.map((id) => erasedKey(model, id))));

  const plan = planDrain(rows, rules, state, selfUserId, erased);

  let written = 0;
  for (const [model, entries] of plan.writes) {
    for (const entry of entries) {
      await putEntry(model, entry);
      written += 1;
    }
  }

  if (plan.consume.length > 0) await Obscura.inboxConsume(plan.consume);

  for (const [reason, ids] of groupBy(plan.discard.map((d) => [d.reason, d.id] as const))) {
    await Obscura.inboxDiscard(ids, reason);
    logError('inbox.discard:' + reason, new Error(`discarded ${ids.length} inbox row(s): ${reason}`));
  }

  return {
    written,
    consumed: plan.consume.length,
    discarded: plan.discard.length,
    touched: [...plan.writes.keys()],
  };
}

/**
 * Drain until the inbox is empty, at most `maxBatches` times: a row that is somehow never consumed
 * must not spin forever.
 */
export async function drainInboxFully(limit = BATCH_SIZE, maxBatches = 100): Promise<DrainResult> {
  const total = nothingDrained();
  const touched = new Set<string>();

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await drainInbox(limit);
    total.written += result.written;
    total.consumed += result.consumed;
    total.discarded += result.discarded;
    result.touched.forEach((m) => touched.add(m));
    if (result.consumed + result.discarded === 0) return { ...total, touched: [...touched] };
  }

  const depth = await Obscura.inboxDepth();
  if (depth > 0) {
    logError('drain.maxBatches', new Error(`${depth} row(s) still in the inbox after ${maxBatches} batches`));
  }
  return { ...total, touched: [...touched] };
}
