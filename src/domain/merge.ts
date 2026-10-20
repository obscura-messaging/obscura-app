/**
 * How two writes to one entry id reconcile (`docs/DOMAIN_CONTRACT.md`, "Merge"). Both rules are
 * idempotent, which is what makes reprocessing an unconsumed inbox row safe.
 */

export type MergeRule = 'APPEND' | 'REPLACE';

export interface Entry<D = Record<string, unknown>> {
  /** The merge key. */
  id: string;
  /** When the author wrote it (ms); the kit clamps it to `now + 60s` on receipt. */
  sentAt: number;
  /** The authenticated author: the transport sender, or this user for a local write. */
  authorUserId: string;
  /** The device whose session decrypted it, or this device for a local write. The REPLACE tie-break. */
  authorDeviceId: string;
  data: D;
}

/**
 * APPEND keeps the first write. REPLACE orders by `(sentAt, authorDeviceId)`; without the device
 * tie-break, equal timestamps would resolve by arrival order and devices would diverge.
 */
function winner(rule: MergeRule, existing: Entry, incoming: Entry): Entry {
  if (rule === 'APPEND') return existing;
  if (incoming.sentAt !== existing.sentAt) return incoming.sentAt > existing.sentAt ? incoming : existing;
  return incoming.authorDeviceId > existing.authorDeviceId ? incoming : existing;
}

/** Fold `incoming` into `state` by entry id. Pure, and independent of arrival order. */
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
