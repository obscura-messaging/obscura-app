import { Obscura } from '../native/ObscuraModule';
import { planSweep } from '../domain/expiry';
import { MODELS } from '../domain/schema';
import {
  eraseEntries, putErasedMarker, readEntries, readErasedMarkers, withEntryLock,
  type StoredRow,
} from './entryStore';
import { logError } from '../utils/log';

/**
 * Apply `planSweep` and return the models it changed. Media is purged while the entry still names
 * it, and every marker is written before anything is erased, so a crash never leaves an erased entry
 * unmarked. Each erase checkpoints the WAL, so each model is erased in one call.
 */
export async function sweepExpired(now: number = Date.now()): Promise<string[]> {
  return withEntryLock(async () => {
    const entriesByModel = new Map<string, StoredRow[]>();
    for (const [model, { expiry }] of MODELS) {
      if (expiry.kind !== 'never') entriesByModel.set(model, await readEntries(model));
    }
    const plan = planSweep({
      now,
      entriesByModel,
      markers: await readErasedMarkers(),
    });

    for (const id of plan.purge) await Obscura.purgeAttachment(id);
    for (const key of plan.mark) await putErasedMarker(key, now);
    for (const [model, ids] of plan.erase) await eraseEntries(model, ids);
    return plan.touched;
  }).catch((e) => {
    logError('expiry.sweep', e);
    return [];
  });
}
