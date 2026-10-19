import { Obscura } from '../native/ObscuraModule';
import { EPHEMERAL_MODELS, STORY_MODEL, planSweep } from '../domain/expiry';
import { SEEN_MODEL } from '../domain/seen';
import { withEntryLock } from './entryLock';
import { putErasedMarker, readEntries, readErasedMarkers, type StoredRow } from './entryStore';
import { logError } from '../utils/log';

/**
 * Apply `planSweep` and return the models it changed. Media is purged while the entry still names
 * it, and every marker is written before anything is erased, so a crash never leaves an erased entry
 * unmarked. Each erase checkpoints the WAL, so each model is erased in one call.
 */
export async function sweepExpired(now: number = Date.now()): Promise<string[]> {
  return withEntryLock(async () => {
    const ephemeral = new Map<string, StoredRow[]>();
    for (const model of EPHEMERAL_MODELS) ephemeral.set(model, await readEntries(model));
    const plan = planSweep({
      now,
      ephemeral,
      stories: await readEntries(STORY_MODEL),
      receipts: await readEntries(SEEN_MODEL),
      markers: await readErasedMarkers(),
    });

    for (const id of plan.purge) await Obscura.purgeAttachment(id);
    for (const key of plan.mark) await putErasedMarker(key, now);
    for (const [model, ids] of plan.erase) await Obscura.entryErase(model, ids);
    return plan.touched;
  }).catch((e) => {
    logError('expiry.sweep', e);
    return [];
  });
}
