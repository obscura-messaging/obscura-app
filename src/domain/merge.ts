/**
 * Merge semantics for synced model entries.
 *
 * Two rules, both idempotent. The idempotence is load-bearing, not incidental: the kit's inbox is
 * drained with `peek → process → consume`, so an app that crashes mid-drain reprocesses those rows.
 * Convergence under replay is what makes that safe. **A future non-idempotent rule breaks the drain
 * contract with it.**
 */

/** How a model reconciles two writes to the same entry id. */
export type MergeRule = 'APPEND' | 'REPLACE';

export interface Entry<D = Record<string, unknown>> {
  /** Unique per logical item; the merge key. */
  id: string;
  /** When the author wrote it (ms). Clamped to `now + 60s` on receipt. */
  sentAt: number;
  /** The authenticated user who wrote it: the transport sender, or this user for a local write. */
  authorUserId: string;
  /**
   * The device whose Signal session decrypted it, or this device for a local write. The REPLACE
   * tie-break, so never taken from the payload.
   */
  authorDeviceId: string;
  data: D;
}

/**
 * Which of two writes to the same id wins.
 *
 * APPEND — the entry is immutable, so the first write seen is kept and later duplicates are
 * ignored. Ids embed a timestamp and randomness, so a repeated id carries identical content and
 * order cannot matter.
 *
 * REPLACE — a total order on `(sentAt, authorDeviceId)`:
 *   1. strictly-greater `sentAt` wins;
 *   2. on equal `sentAt`, the lexicographically-higher `authorDeviceId` wins;
 *   3. equal on both is the same logical write — idempotent, keep what we have.
 *
 * Rule 2 is required. Without it an equal-timestamp conflict resolves to "whichever arrived
 * first", so two devices that receive the two writes in different orders converge to DIFFERENT
 * states and never reconcile — silently, and invisibly to single-device testing (`DOMAIN_CONTRACT.md`).
 * `pix.viewedAt` is written by the *recipient*, i.e. a second user, so equal timestamps are a real
 * collision and not a thought experiment.
 */
export function winner(rule: MergeRule, existing: Entry, incoming: Entry): Entry {
  if (rule === 'APPEND') return existing;

  if (incoming.sentAt > existing.sentAt) return incoming;
  if (incoming.sentAt < existing.sentAt) return existing;
  if (incoming.authorDeviceId > existing.authorDeviceId) return incoming;
  return existing;
}

/**
 * Fold `incoming` into `state`, keyed by entry id. Pure: returns a new map.
 *
 * Convergent by construction — applying the same set of writes in any arrival order yields the
 * identical result, which is what the `applyOrders` in the conformance vectors check.
 */
export function merge(
  rule: MergeRule,
  state: ReadonlyMap<string, Entry>,
  incoming: readonly Entry[],
): Map<string, Entry> {
  const next = new Map(state);
  for (const entry of incoming) {
    const existing = next.get(entry.id);
    next.set(entry.id, existing === undefined ? entry : winner(rule, existing, entry));
  }
  return next;
}

/** Convenience: merge into an empty state. */
export function mergeAll(rule: MergeRule, incoming: readonly Entry[]): Map<string, Entry> {
  return merge(rule, new Map(), incoming);
}
