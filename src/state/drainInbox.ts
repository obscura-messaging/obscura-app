import { Obscura, type InboxRow } from '../native/ObscuraModule';
import { planDrain, type DrainRow } from '../domain/drain';
import { ERASED_MODEL, erasedKey } from '../domain/expiry';
import type { Entry } from '../domain/merge';
import { modelRules } from '../models/schema';
import { withEntryLock } from './entryLock';
import { readEntriesById } from './readEntries';
import { logError } from '../utils/log';

/**
 * Drain the kit's inbox into the entry store, applying the plan from `drain.ts`.
 *
 * ```
 * peek → plan → WRITE entries → THEN consume → discard
 * ```
 *
 * The inbox row is the only copy of a message, so entries are written before rows are consumed. If
 * a write throws, the rows stay and the next drain reprocesses them; merge is idempotent.
 */

function toDrainRow(row: InboxRow): DrainRow {
  return {
    id: row.id,
    kind: row.kind,
    modelKey: row.modelKey,
    entryId: row.entryId,
    sentAt: row.sentAt,
    // Server-stamped sender identity.
    senderUserId: row.senderUserId,
    senderDeviceId: row.senderDeviceId,
    payload: row.payload,
  };
}

/** The stored entries a batch names, per model. Merge is per entry id, so nothing else is needed. */
async function currentState(
  idsByModel: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, Map<string, Entry>>> {
  const state = new Map<string, Map<string, Entry>>();
  for (const [model, ids] of idsByModel) {
    state.set(model, new Map((await readEntriesById(model, ids)).map((e) => [e.id, e])));
  }
  return state;
}

export interface DrainResult {
  /** Rows written to the entry store. */
  written: number;
  consumed: number;
  discarded: number;
  /** Models whose entries changed, so the caller can refresh only those. */
  touched: string[];
}

/**
 * Drain up to `limit` rows. Returns what happened, so the caller can refresh the right slices.
 *
 * Serialised against every other entry writer by `withEntryLock`. That is load-bearing, not
 * defensive: this function READS the current state, decides, then writes — and a write landing
 * inside that window is computed against a snapshot that never saw it, so the merge silently
 * reverts it. See `entryLock.ts` for the concrete failure.
 */
export async function drainInbox(limit = 50): Promise<DrainResult> {
  return withEntryLock(() => drainInboxUnlocked(limit));
}

const EMPTY_RESULT: DrainResult = { written: 0, consumed: 0, discarded: 0, touched: [] };

async function drainInboxUnlocked(limit: number): Promise<DrainResult> {
  const rows = await Obscura.inboxPeek(limit);
  if (rows.length === 0) return { ...EMPTY_RESULT };

  // Authorization needs to know who I am, and there is no safe default: an empty `selfUserId` would
  // make every conversation check fail closed and discard real mail. Refuse to drain instead — the
  // rows stay in the inbox and the next trigger retries, which is what `peek` being side-effect free
  // is for.
  const selfUserId = (await Obscura.getUserId()) ?? '';
  if (selfUserId === '') {
    logError('drain.noIdentity', new Error('inbox drain skipped: the session identity is not loaded'));
    return { ...EMPTY_RESULT };
  }

  const rules = modelRules();
  // Only the entries this batch names are loaded, so a drain costs the batch, not the whole store.
  const idsByModel = new Map<string, string[]>();
  for (const r of rows) {
    if (r.modelKey === null || r.entryId === null || !rules.has(r.modelKey)) continue;
    idsByModel.set(r.modelKey, [...(idsByModel.get(r.modelKey) ?? []), r.entryId]);
  }
  const state = await currentState(idsByModel);

  const erasedKeys = [...idsByModel].flatMap(([model, ids]) => ids.map((id) => erasedKey(model, id)));
  const erased = new Set(
    erasedKeys.length === 0 ? [] : (await Obscura.entryGet(ERASED_MODEL, erasedKeys)).map((e) => e.id),
  );
  const plan = planDrain(rows.map(toDrainRow), rules, state, selfUserId, erased);

  // 1. WRITE FIRST. A row is only safe to consume once its entry is durably stored.
  let written = 0;
  const touched: string[] = [];
  for (const [model, entries] of plan.writes) {
    for (const entry of entries) {
      await Obscura.entryPut(
        model,
        entry.id,
        JSON.stringify(entry.data),
        entry.sentAt,
        entry.authorDeviceId,
      );
      written += 1;
    }
    if (entries.length > 0) touched.push(model);
  }

  // 2. THEN consume. If step 1 threw, we never get here and the rows are redelivered next drain.
  if (plan.consume.length > 0) await Obscura.inboxConsume(plan.consume);

  // 3. Discard what can never be processed, grouped by reason. Also log it app-side so discards show
  //    in the debug screen; `unauthorized-sender` is a security event.
  const byReason = new Map<string, number[]>();
  for (const { id, reason } of plan.discard) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
  }
  for (const [reason, ids] of byReason) {
    await Obscura.inboxDiscard(ids, reason);
    logError('inbox.discard:' + reason, new Error(`discarded ${ids.length} inbox row(s): ${reason}`));
  }

  return {
    written,
    consumed: plan.consume.length,
    discarded: plan.discard.length,
    touched,
  };
}

/**
 * Drain repeatedly until the inbox is empty.
 *
 * Bounded by `maxBatches` rather than looping on `inboxDepth() > 0`: a row that is somehow neither
 * consumed nor discarded would spin forever, and a drain that cannot terminate is worse than one
 * that stops early and reports it. `drain.ts` guarantees every row is accounted for, so this bound
 * should never be reached — which is exactly why hitting it is worth logging.
 */
export async function drainInboxFully(limit = 50, maxBatches = 100): Promise<DrainResult> {
  const total: DrainResult = { written: 0, consumed: 0, discarded: 0, touched: [] };
  const touched = new Set<string>();
  let hitTheBound = true;

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await drainInbox(limit);
    total.written += result.written;
    total.consumed += result.consumed;
    total.discarded += result.discarded;
    result.touched.forEach((m) => touched.add(m));
    if (result.consumed + result.discarded === 0) {
      hitTheBound = false;
      break;
    }
  }

  // Logged AFTER the loop, and only when the bound was actually reached with rows still waiting.
  // The old test — `i === maxBatches - 1` inside the loop — fired whenever the last permitted batch
  // made progress, which includes the batch that *emptied* the inbox: a clean finish reported as a
  // failure, every time the row count happened to be a multiple of the batch size.
  if (hitTheBound) {
    const depth = await Obscura.inboxDepth();
    if (depth > 0) {
      logError(
        'drain.maxBatches',
        new Error(`${depth} row(s) still in the inbox after ${maxBatches} batches`),
      );
    }
  }

  total.touched = [...touched];
  return total;
}
