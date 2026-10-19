/**
 * Disappearing entries: what expires and when. Every device holding an entry runs the same clock and
 * erases its own copy; nothing is synced as a delete.
 */

import { groupBy } from '../utils/collections';
import type { Entry } from './merge';
import { SEEN_MODEL, indexReceipts, seenEntryId, viewedAtFor } from './seen';

/** Models whose entries disappear once seen, and which get seen receipts. */
export const EPHEMERAL_MODELS = ['directMessage', 'pix'] as const;

export function isEphemeral(model: string): boolean {
  return (EPHEMERAL_MODELS as readonly string[]).includes(model);
}

/** Stories expire on their own clock, without receipts. */
export const STORY_MODEL = 'story';

/** A seen entry is erased this long after it was seen. */
export const EXPIRE_AFTER_MS = 15 * 60 * 1000;

/** Nothing ephemeral outlives this: unseen entries, orphan receipts, erased markers. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A story is erased this long after it was posted. */
export const STORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Local-only model recording erased entries, so a replayed write for one is not stored again. */
export const ERASED_MODEL = '_erased';

export function erasedKey(model: string, id: string): string {
  return `${model}:${id}`;
}

export function expiresAt(sentAt: number, viewedAt: number | null): number {
  const ceiling = sentAt + MAX_AGE_MS;
  return viewedAt === null ? ceiling : Math.min(ceiling, viewedAt + EXPIRE_AFTER_MS);
}

export function storyExpiresAt(sentAt: number): number {
  return sentAt + STORY_MAX_AGE_MS;
}

export interface SweepInput {
  now: number;
  /** Stored entries of each of `EPHEMERAL_MODELS`. */
  ephemeral: ReadonlyMap<string, readonly Entry[]>;
  stories: readonly Entry[];
  receipts: readonly Entry[];
  markers: ReadonlyArray<{ id: string; sentAt: number }>;
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
 * Everything a sweep removes: expired ephemeral entries with their receipts, stories past their age,
 * receipts whose entry never arrived, and old erased markers.
 */
export function planSweep({ now, ephemeral, stories, receipts, markers }: SweepInput): SweepPlan {
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

  const receiptIndex = indexReceipts(receipts);
  const live = new Set<string>();
  for (const model of EPHEMERAL_MODELS) {
    for (const entry of ephemeral.get(model) ?? []) {
      const receiptId = seenEntryId(model, entry.id);
      live.add(receiptId);
      if (expiresAt(entry.sentAt, viewedAtFor(model, entry, receiptIndex)) > now) continue;
      expire(model, entry);
      if (receiptIndex.has(receiptId)) {
        mark.push(erasedKey(SEEN_MODEL, receiptId));
        erase(SEEN_MODEL, receiptId);
      }
    }
  }

  for (const story of stories) {
    if (storyExpiresAt(story.sentAt) <= now) expire(STORY_MODEL, story);
  }

  for (const receipt of receipts) {
    if (!live.has(receipt.id) && receipt.sentAt + MAX_AGE_MS <= now) erase(SEEN_MODEL, receipt.id);
  }

  for (const marker of markers) {
    if (marker.sentAt + MAX_AGE_MS <= now) erase(ERASED_MODEL, marker.id);
  }

  return { purge, mark, erase: groupBy(erasures), touched: [...touched] };
}
