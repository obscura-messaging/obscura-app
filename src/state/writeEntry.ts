import { Obscura } from '../native/ObscuraModule';
import { resolveAudience, type AudienceFriend } from '../domain/audience';
import { obscuraSchema, audienceFor, fieldsFor } from '../models/schema';
import { invalidFields } from '../domain/fields';
import { reachedRecipients, SendFailed } from '../domain/delivery';
import { withEntryLock } from './entryLock';
import { putEntry, readEntries, readEntriesById, storedSentAt } from './entryStore';
import type { Entry } from '../domain/merge';
import { logError } from '../utils/log';

/**
 * A new entry id. The random half keeps two devices writing in the same millisecond from colliding,
 * which APPEND would resolve by silently dropping one.
 */
export function newEntryId(model: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${model}_${Date.now()}_${random}`;
}

/** `Date.now()`, or 1 ms past the stored copy when that is ahead (a peer's fast clock). */
async function nextSentAt(model: string, id: string): Promise<number> {
  const now = Date.now();
  const existing = await storedSentAt(model, id);
  return existing === undefined ? now : Math.max(now, existing + 1);
}

export interface WriteEntryArgs {
  model: string;
  /** Omit to create; pass an existing id to replace it. */
  id?: string;
  data: Record<string, unknown>;
  selfUserId: string;
  myDeviceId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Resolve the audience, store the entry, then send it (`docs/DOMAIN_CONTRACT.md`, "Local writes").
 * A send that reaches nobody keeps the entry, marks it for the outbox and rethrows.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be resolved; nothing is stored or sent.
 * @returns the entry id.
 */
export async function writeEntry(args: WriteEntryArgs): Promise<string> {
  const { model, data, selfUserId, myDeviceId, friends } = args;

  const recipients = resolveAudience(audienceFor(model), data, selfUserId, friends);
  const invalid = invalidFields(fieldsFor(model), data);
  if (invalid.length > 0) throw new Error(`${model}: invalid fields ${invalid.join(', ')}`);

  const id = args.id ?? newEntryId(model);

  // The send stays outside the lock so one slow recipient cannot stall every write.
  const entry = await withEntryLock(async (): Promise<Entry> => {
    const written = {
      id, sentAt: await nextSentAt(model, id), authorUserId: selfUserId, authorDeviceId: myDeviceId, data,
    };
    await putEntry(model, written);
    return written;
  });

  try {
    await send(model, entry, recipients);
  } catch (e) {
    await setUndelivered(model, entry, true).catch((markError: unknown) => {
      logError('writeEntry.mark:' + model, markError);
    });
    logError('writeEntry.send:' + model, e);
    throw e;
  }
  return id;
}

/** Throws `SendFailed` when the send reached none of its recipients. */
async function send(model: string, entry: Entry, recipients: string[]): Promise<void> {
  const report = await Obscura.sendEntry(
    recipients, model, entry.id, entry.sentAt, JSON.stringify(entry.data),
  );
  if (!reachedRecipients(recipients, report)) throw new SendFailed(model, report);
}

/**
 * Set the outbox mark on this version of an entry. A newer version stored meanwhile is left alone:
 * re-putting this one would roll it back.
 */
async function setUndelivered(model: string, version: Entry, undelivered: boolean): Promise<void> {
  await withEntryLock(async () => {
    const [current] = await readEntriesById(model, [version.id]);
    if (current === undefined || current.sentAt !== version.sentAt) return;
    await putEntry(model, current, undelivered);
  });
}

export interface FlushOutboxArgs {
  selfUserId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Retry every undelivered entry, clearing the mark on those that get through. One that still fails
 * keeps its mark for the next trigger.
 *
 * @returns how many entries were delivered.
 */
export async function flushOutbox({ selfUserId, friends }: FlushOutboxArgs): Promise<number> {
  let delivered = 0;
  for (const model of Object.keys(obscuraSchema)) {
    for (const row of await readEntries(model)) {
      if (!row.undelivered) continue;
      try {
        await send(model, row, resolveAudience(audienceFor(model), row.data, selfUserId, friends));
      } catch (e) {
        logError('flushOutbox.send:' + model, e);
        continue;
      }
      await setUndelivered(model, row, false);
      delivered += 1;
    }
  }
  return delivered;
}
