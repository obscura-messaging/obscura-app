/**
 * Seen receipts and disappearing entries.
 *
 * Every device holding an entry runs the same expiry rules (derived from `MODELS` in `schema.ts`)
 * and erases its own copy; nothing is synced as a delete.
 */

import { groupBy } from '../utils/collections';
import type { Entry } from './merge';
import {
  EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS, MODELS,
  type ModelDeclaration,
} from './schema';

export { EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS };

export const SEEN_MODEL = 'seen';

/** An entry as screens see it: `data` as sent, plus when its recipient saw it (ephemeral models). */
export type ScreenEntry<D = Record<string, unknown>> = Entry<D> & { viewedAt: number | null };

/** Local-only model recording erased entries, so a replayed write for one is not stored again. */
export const ERASED_MODEL = '_erased';

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

export function isEphemeral(model: string): boolean {
  return MODELS.get(model)?.expiry.kind === 'afterSeen';
}

export function erasedKey(model: string, id: string): string {
  return `${model}:${id}`;
}

export function expiresAt(
  sentAt: number,
  viewedAt: number | null,
  afterSeenMs = EXPIRE_AFTER_MS,
  maxAgeMs = MAX_AGE_MS,
): number {
  const ceiling = sentAt + maxAgeMs;
  return viewedAt === null ? ceiling : Math.min(ceiling, viewedAt + afterSeenMs);
}

export function storyExpiresAt(sentAt: number): number {
  return sentAt + STORY_MAX_AGE_MS;
}

export interface SweepInput {
  now: number;
  /** Stored entries per model name. */
  entriesByModel: ReadonlyMap<string, readonly Entry[]>;
  markers: ReadonlyArray<{ id: string; sentAt: number }>;
  models?: ReadonlyMap<string, ModelDeclaration>;
}

export interface SweepPlan {
  /** Attachments whose decrypted copy to delete. */
  purge: string[];
  /** Erased keys to mark before anything is erased. */
  mark: string[];
  /** Ids to erase, per model. */
  erase: Map<string, string[]>;
  /** Models whose visible entries changed. */
  touched: string[];
}

/**
 * Everything a sweep removes, derived from each model's declared `expiry` rule:
 * - `afterSeen` entries past their seen or max-age deadline, together with their receipts
 * - `afterSent` entries past their max-age deadline
 * - `withTarget` receipts whose target entry never arrived and passed `maxAgeMs`
 * - `_erased` markers past `MAX_AGE_MS`
 */
export function planSweep({ now, entriesByModel, markers, models = MODELS }: SweepInput): SweepPlan {
  const purge: string[] = [];
  const mark: string[] = [];
  const erasures: Array<[string, string]> = [];
  const touched = new Set<string>();
  const erase = (model: string, id: string) => erasures.push([model, id]);
  const expire = (model: string, entry: Entry) => {
    if (typeof entry.data.mediaRef === 'string') purge.push(entry.data.mediaRef);
    mark.push(erasedKey(model, entry.id));
    erase(model, entry.id);
    touched.add(model);
  };

  const receipts = entriesByModel.get(SEEN_MODEL) ?? [];
  const receiptIndex = indexReceipts(receipts);
  const liveReceiptIds = new Set<string>();

  for (const [model, { expiry }] of models) {
    const entries = entriesByModel.get(model) ?? [];
    if (expiry.kind === 'afterSeen') {
      for (const entry of entries) {
        const receiptId = seenEntryId(model, entry.id);
        liveReceiptIds.add(receiptId);
        const viewedAt = viewedAtFor(model, entry, receiptIndex);
        if (expiresAt(entry.sentAt, viewedAt, expiry.afterSeenMs, expiry.maxAgeMs) > now) continue;
        expire(model, entry);
        if (receiptIndex.has(receiptId)) {
          mark.push(erasedKey(SEEN_MODEL, receiptId));
          erase(SEEN_MODEL, receiptId);
        }
      }
    } else if (expiry.kind === 'afterSent') {
      for (const entry of entries) {
        if (entry.sentAt + expiry.maxAgeMs <= now) expire(model, entry);
      }
    }
  }

  for (const [model, { expiry }] of models) {
    if (expiry.kind !== 'withTarget') continue;
    for (const receipt of entriesByModel.get(model) ?? []) {
      if (!liveReceiptIds.has(receipt.id) && receipt.sentAt + expiry.maxAgeMs <= now) {
        erase(model, receipt.id);
      }
    }
  }

  for (const marker of markers) {
    if (marker.sentAt + MAX_AGE_MS <= now) erase(ERASED_MODEL, marker.id);
  }

  return { purge, mark, erase: groupBy(erasures), touched: [...touched] };
}
