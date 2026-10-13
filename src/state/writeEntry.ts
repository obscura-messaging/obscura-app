import { Obscura } from '../native/ObscuraModule';
import { resolveAudience, type AudienceFriend } from '../domain/audience';
import { obscuraSchema, audienceFor, fieldsFor, AUTHOR_USER_ID } from '../models/schema';
import { invalidFields } from '../domain/fields';
import { reachedRecipients, SendFailed } from '../domain/delivery';
import { withEntryLock } from './entryLock';
import { readEntries } from './readEntries';
import { logError } from '../utils/log';

/**
 * Writing an entry: store it locally, then send it (`docs/DOMAIN_CONTRACT.md`, "Local writes").
 *
 * ## The order, and why
 *
 * ```
 * resolve audience → WRITE locally → THEN send
 * ```
 *
 * - **Audience first**, because it can throw. An entry with an unresolvable audience must not be
 *   stored either: a local row the user can see but that reached nobody is worse than a refusal.
 * - **Write before send**, because the local write is the one that must not be lost. The user's own
 *   content is theirs whether or not the network cooperated; a send failure is retriable, a lost
 *   write is not.
 *
 * ## The sender writes its own copy
 *
 * `send` produces no inbox row for the sender, so this is the only place an outgoing entry is
 * stored.
 */

/**
 * A new entry id.
 *
 * Timestamp plus randomness, matching the shape the kit generated (`story_1706389200_abc123`). Both
 * halves matter: the timestamp keeps ids roughly ordered for a human reading the store, and the
 * randomness is what makes APPEND's dedupe-by-id safe — two devices creating an entry in the same
 * millisecond must not collide, or one would silently discard the other's.
 */
export function newEntryId(model: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${model}_${Date.now()}_${random}`;
}

/**
 * A timestamp that is guaranteed to win against what is already stored for this entry.
 *
 * Normally just `Date.now()`. When an existing row is ahead of us — a peer's clock up to 60 s fast
 * (the kit's future-timestamp clamp), or our own clock moving backwards — it steps one
 * millisecond past it instead. `+1` rather than a larger jump because the goal is only to win this
 * comparison, not to poison every future one.
 */
async function nextSentAt(model: string, id: string): Promise<number> {
  const now = Date.now();
  try {
    const existing = (await Obscura.entryAll(model)).find((e) => e.id === id);
    return existing === undefined ? now : Math.max(now, existing.sentAt + 1);
  } catch {
    // If we cannot read, do not block the write — `now` is right in every case except the skew one.
    return now;
  }
}

export interface WriteEntryArgs {
  model: string;
  /** Omit to create; pass an existing id to update (a REPLACE model's second write). */
  id?: string;
  data: Record<string, unknown>;
  selfUserId: string;
  myDeviceId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Store an entry locally and send it to its audience.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be resolved — nothing is stored or sent.
 * @returns the entry id, generated when not supplied.
 */
export async function writeEntry(args: WriteEntryArgs): Promise<string> {
  const { model, data, selfUserId, myDeviceId, friends } = args;

  // Both checks throw before anything is written.
  const recipients = resolveAudience(audienceFor(model), data, selfUserId, friends);
  const invalid = invalidFields(fieldsFor(model), data);
  if (invalid.length > 0) throw new Error(`${model}: invalid fields ${invalid.join(', ')}`);

  const id = args.id ?? newEntryId(model);

  // `_authorUserId` is local-only: this device wrote it, so this user is the author.
  const stored: Record<string, unknown> = { ...data, [AUTHOR_USER_ID]: selfUserId };
  const wireData = { ...stored };
  delete wireData[AUTHOR_USER_ID];
  const payload = JSON.stringify(wireData);

  // `sentAt` must beat whatever is already stored, or a local write can lose to it.
  //
  // `entryPut` is a blind upsert, so a lower `sentAt` would win locally and lose on every other
  // device. A stored `sentAt` can be up to 60 s in our future (a peer's fast clock), so step past it.
  //
  // Read and write under the lock together: computing `sentAt` from a row that a concurrent drain
  // then replaces would put us right back where we started.
  //
  // The SEND deliberately stays OUTSIDE the lock — it is a network call, and holding a store-wide
  // lock across it would let one slow recipient stall every write in the app.
  const sentAt = await withEntryLock(async () => {
    const next = await nextSentAt(model, id);
    // This device is the author, and the REPLACE tie-break compares author devices.
    await Obscura.entryPut(model, id, JSON.stringify(stored), next, myDeviceId);
    return next;
  });

  try {
    const report = await Obscura.sendEntry(recipients, model, id, sentAt, payload);
    if (!reachedRecipients(recipients, report)) throw new SendFailed(model, report);
  } catch (e) {
    // The local write already succeeded and STAYS — the user's content is theirs whether or not the
    // network cooperated, and undoing it would be the worse failure.
    //
    // But the error is re-thrown rather than only logged, because it means the send reached
    // NOBODY (a partial delivery is a success; see `domain/delivery.ts`). Swallowing that
    // would leave the user looking at an entry in their own timeline, with no indication it got
    // nowhere, forever. An earlier version justified swallowing with "the kit queues and retries" —
    // that is not true in the sense required: the retry queue is in-memory, flushed on the next
    // send, and lost on process death.
    //
    // Which is why the row is also MARKED. Telling the user once and then forgetting is what left
    // an undelivered entry sitting in their timeline looking sent, forever, with no trigger that
    // would ever retry it — the receive side has four (reconnect, foreground, cold start, wake) and
    // the send side had none. See `flushOutbox`.
    await markUndelivered(model, id, sentAt);
    logError('writeEntry.send:' + model, e);
    throw e;
  }

  return id;
}

// ─── The outbox ──────────────────────────────────────────
//
const UNDELIVERED_METADATA = JSON.stringify({ undelivered: true });

function isUndelivered(localMetadata: string | null): boolean {
  if (localMetadata === null) return false;
  try {
    return (JSON.parse(localMetadata) as { undelivered?: unknown }).undelivered === true;
  } catch {
    return false;
  }
}

/**
 * Record that this entry did not reach anybody, without disturbing a newer write.
 *
 * The read-then-write under the lock is not decoration: `entryPut` is blind, so re-putting our own
 * `sentAt` after a concurrent drain stored a NEWER version of the same id would roll that version
 * back. If we have been superseded there is also nothing to retry — the newer write is what the
 * peers should get, and it has its own delivery outcome.
 */
async function markUndelivered(
  model: string, id: string, sentAt: number,
): Promise<void> {
  try {
    await withEntryLock(async () => {
      const existing = (await Obscura.entryAll(model)).find((e) => e.id === id);
      if (existing === undefined || existing.sentAt !== sentAt) return;
      await Obscura.entryPut(
        model,
        id,
        existing.data,
        sentAt,
        existing.authorDeviceId,
        UNDELIVERED_METADATA,
      );
    });
  } catch (e) {
    // Best effort. The caller is already throwing about the send; failing to record the retry must
    // not replace that error with a less useful one.
    logError('writeEntry.mark:' + model, e);
  }
}

export interface FlushOutboxArgs {
  selfUserId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Retry every entry whose send reached nobody, and clear the mark on the ones that get through.
 *
 * Wired to the same signals as the inbox drain (reconnect, foreground, cold start) — the asymmetry
 * this closes is that those signals mean "the network is back", which is exactly as true for the
 * outbound half as for the inbound one.
 *
 * @returns how many entries were delivered on this pass.
 */
export async function flushOutbox(args: FlushOutboxArgs): Promise<number> {
  const { selfUserId, friends } = args;
  let delivered = 0;

  for (const model of Object.keys(obscuraSchema)) {
    let stored;
    try {
      stored = await readEntries(model);
    } catch (e) {
      logError('flushOutbox.read:' + model, e);
      continue;
    }

    for (const row of stored) {
      if (!isUndelivered(row.localMetadata)) continue;

      const payload = { ...row.data };
      delete payload[AUTHOR_USER_ID];
      try {
        const recipients = resolveAudience(audienceFor(model), payload, selfUserId, friends);
        const report = await Obscura.sendEntry(recipients, model, row.id, row.sentAt, JSON.stringify(payload));
        if (!reachedRecipients(recipients, report)) throw new SendFailed(model, report);
      } catch (e) {
        // Still undelivered, or now unroutable (a friend removed since). Either way the mark stays
        // and the next trigger tries again — dropping it silently is the behaviour being fixed.
        logError('flushOutbox.send:' + model, e);
        continue;
      }

      // Clearing the mark keeps the row's `(sentAt, authorDeviceId)` exactly as it was: this is
      // bookkeeping, and it must not shift the entry's position in a REPLACE comparison.
      await withEntryLock(async () => {
        const current = (await Obscura.entryAll(model)).find((e) => e.id === row.id);
        if (current === undefined || current.sentAt !== row.sentAt) return; // superseded
        await Obscura.entryPut(
          model,
          row.id,
          current.data,
          row.sentAt,
          current.authorDeviceId,
          null,
        );
      });
      delivered += 1;
    }
  }

  return delivered;
}
