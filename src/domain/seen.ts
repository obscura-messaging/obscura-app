/**
 * Seen receipts. A receipt is its own APPEND `seen` entry, written by the recipient and sent to both
 * participants, so neither side can rewrite the message it marks. Its id names the entry it marks.
 * Pure; `state/store.ts` and `state/expiry.ts` apply it.
 */

import type { Entry } from './merge';

export const SEEN_MODEL = 'seen';

export function seenEntryId(model: string, entryId: string): string {
  return `seen_${model}_${entryId}`;
}

/** Stored receipts, keyed by entry id. */
export type Receipts = ReadonlyMap<string, Entry>;

export function indexReceipts(receipts: readonly Entry[]): Receipts {
  return new Map(receipts.map((r) => [r.id, r]));
}

/**
 * When the entry was seen, or `null`. A receipt counts only if someone other than the entry's author
 * wrote it in the entry's conversation. `viewedAt` comes from the recipient's clock, so it is capped
 * at the receipt's `sentAt`, which the kit clamps on receipt.
 */
export function viewedAtFor(model: string, entry: Entry, receipts: Receipts): number | null {
  const receipt = receipts.get(seenEntryId(model, entry.id));
  if (receipt === undefined) return null;
  if (receipt.authorUserId === entry.authorUserId) return null;
  if (receipt.data.conversationId !== entry.data.conversationId) return null;
  const viewedAt = receipt.data.viewedAt;
  return typeof viewedAt === 'number' ? Math.min(viewedAt, receipt.sentAt) : null;
}
