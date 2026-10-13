/**
 * Seen receipts. A receipt is its own APPEND `seen` entry, written by the recipient and sent to both
 * participants, so neither side can rewrite the message it marks.
 */

import type { Entry } from './merge';

export const SEEN_MODEL = 'seen';

export function seenEntryId(model: string, entryId: string): string {
  return `seen_${model}_${entryId}`;
}

export function indexReceipts(receipts: readonly Entry[]): ReadonlyMap<string, Entry> {
  return new Map(receipts.map((r) => [r.id, r]));
}

/**
 * When the entry was seen, or `null`. A receipt counts only if someone other than the author wrote it
 * in the entry's conversation. `viewedAt` is the recipient's clock, so it is capped at the receipt's
 * kit-clamped `sentAt`.
 */
export function viewedAtFor(model: string, entry: Entry, receipts: ReadonlyMap<string, Entry>): number | null {
  const receipt = receipts.get(seenEntryId(model, entry.id));
  if (receipt === undefined) return null;
  if (receipt.authorUserId === entry.authorUserId) return null;
  if (receipt.data.conversationId !== entry.data.conversationId) return null;
  const viewedAt = receipt.data.viewedAt;
  return typeof viewedAt === 'number' ? Math.min(viewedAt, receipt.sentAt) : null;
}
