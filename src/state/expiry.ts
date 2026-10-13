import { Obscura } from '../native/ObscuraModule';
import {
  EPHEMERAL_MODELS, ERASED_MODEL, MAX_AGE_MS, STORY_MODEL, erasedKey, expiresAt, storyExpiresAt,
} from '../domain/expiry';
import { SEEN_MODEL, indexReceipts, seenEntryId, viewedAtFor } from '../domain/seen';
import type { Entry } from '../domain/merge';
import { withEntryLock } from './entryLock';
import { readEntries } from './entryStore';
import { logError } from '../utils/log';

/**
 * Erasures gathered during one sweep. Each erase checkpoints the WAL, so a sweep erases each model
 * once, after every marker is written: a crash in between never leaves an erased entry unmarked.
 */
class Erasures {
  private readonly ids = new Map<string, string[]>();

  /** Erase an entry and its decrypted media, and record it so a replay stays gone. */
  async entry(model: string, entry: Entry, now: number): Promise<void> {
    // Media first: once the entry is gone, nothing records which attachment it used.
    if (typeof entry.data.mediaRef === 'string') await Obscura.purgeAttachment(entry.data.mediaRef);
    await this.marked(model, entry.id, now);
  }

  async marked(model: string, id: string, now: number): Promise<void> {
    await Obscura.entryPut(ERASED_MODEL, erasedKey(model, id), '{}', now, '');
    this.unmarked(model, id);
  }

  unmarked(model: string, id: string): void {
    const ids = this.ids.get(model);
    if (ids === undefined) this.ids.set(model, [id]);
    else ids.push(id);
  }

  async commit(): Promise<void> {
    for (const [model, ids] of this.ids) await Obscura.entryErase(model, ids);
  }
}

/**
 * Erase every expired ephemeral entry with its receipt and decrypted media, every story past its
 * age, drop receipts whose entry never arrived, and prune old erased markers. Returns the models it
 * changed.
 */
export async function sweepExpired(now: number = Date.now()): Promise<string[]> {
  return withEntryLock(async () => {
    const touched = new Set<string>();
    const erase = new Erasures();
    const receiptRows = await readEntries(SEEN_MODEL);
    const receipts = indexReceipts(receiptRows);
    const live = new Set<string>();

    for (const model of EPHEMERAL_MODELS) {
      for (const entry of await readEntries(model)) {
        const receiptId = seenEntryId(model, entry.id);
        live.add(receiptId);
        if (expiresAt(entry.sentAt, viewedAtFor(model, entry, receipts)) > now) continue;
        await erase.entry(model, entry, now);
        if (receipts.has(receiptId)) await erase.marked(SEEN_MODEL, receiptId, now);
        touched.add(model);
      }
    }

    for (const entry of await readEntries(STORY_MODEL)) {
      if (storyExpiresAt(entry.sentAt) > now) continue;
      await erase.entry(STORY_MODEL, entry, now);
      touched.add(STORY_MODEL);
    }

    for (const receipt of receiptRows) {
      if (!live.has(receipt.id) && receipt.sentAt + MAX_AGE_MS <= now) erase.unmarked(SEEN_MODEL, receipt.id);
    }

    for (const marker of await Obscura.entryAll(ERASED_MODEL)) {
      if (marker.sentAt + MAX_AGE_MS <= now) erase.unmarked(ERASED_MODEL, marker.id);
    }

    await erase.commit();
    return [...touched];
  }).catch((e) => {
    logError('expiry.sweep', e);
    return [];
  });
}
