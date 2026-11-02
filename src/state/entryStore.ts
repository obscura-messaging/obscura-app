import { Obscura, type StoredEntry } from '../native/ObscuraModule';
import { ERASED_MODEL } from '../domain/expiry';
import { parseJsonObject } from '../domain/schema';
import type { Entry } from '../domain/merge';
import { logError } from '../utils/log';

/**
 * The only module that reads or writes the kit's entry store, together with the mutex that
 * serializes read-merge-write cycles against `entryPut`'s blind upsert.
 *
 * An entry's `data` is stored verbatim; the outbox mark travels in `localMetadata`.
 */

let tail: Promise<unknown> = Promise.resolve();

/** Run `work` after all earlier entry-store work settles. */
export function withEntryLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}

const UNDELIVERED_METADATA = JSON.stringify({ undelivered: true });

export interface StoredRow extends Entry {
  /** A send of this version reached nobody, so the outbox retries it. */
  undelivered: boolean;
}

/** A model's stored entries. Rows that do not decode are logged and skipped. */
export async function readEntries(model: string): Promise<StoredRow[]> {
  return decodeAll(model, await Obscura.entryAll(model));
}

/** The named entries that exist. */
export async function readEntriesById(model: string, ids: readonly string[]): Promise<StoredRow[]> {
  return ids.length === 0 ? [] : decodeAll(model, await Obscura.entryGet(model, [...ids]));
}

/** The stored `sentAt` of an entry, even one that does not decode. */
export async function storedSentAt(model: string, id: string): Promise<number | undefined> {
  return (await Obscura.entryGet(model, [id]))[0]?.sentAt;
}

/** Store an entry. A blind upsert: callers merge first. */
export function putEntry(model: string, entry: Entry, undelivered = false): Promise<void> {
  return Obscura.entryPut(
    model,
    entry.id,
    JSON.stringify(entry.data),
    entry.sentAt,
    entry.authorUserId,
    entry.authorDeviceId,
    undelivered ? UNDELIVERED_METADATA : null,
  );
}

/** Record an erased entry's `erasedKey`, so a replayed write for it is not stored again. */
export function putErasedMarker(key: string, erasedAt: number): Promise<void> {
  return Obscura.entryPut(ERASED_MODEL, key, '{}', erasedAt, '', '', null);
}

/** Securely erase entries of `model` in one batch. */
export function eraseEntries(model: string, ids: readonly string[]): Promise<void> {
  return Obscura.entryErase(model, [...ids]);
}

/** The given erased keys that have a marker. */
export async function readErasedKeys(keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  return new Set((await Obscura.entryGet(ERASED_MODEL, [...keys])).map((e) => e.id));
}

/** Every erased marker, as `{ id: erasedKey, sentAt: erasedAt }`. */
export async function readErasedMarkers(): Promise<Array<{ id: string; sentAt: number }>> {
  return (await Obscura.entryAll(ERASED_MODEL)).map(({ id, sentAt }) => ({ id, sentAt }));
}

function decodeAll(model: string, entries: readonly StoredEntry[]): StoredRow[] {
  return entries.flatMap((e) => {
    try {
      return [decode(e)];
    } catch (err) {
      logError('entries.decode:' + model, err);
      return [];
    }
  });
}

function decode(e: StoredEntry): StoredRow {
  const data = parseJsonObject(e.data);
  if (data === null) {
    throw new Error(`entry ${e.id} is not a JSON object`);
  }
  if (e.authorUserId === '') {
    throw new Error(`entry ${e.id} has no author`);
  }
  return {
    id: e.id,
    sentAt: e.sentAt,
    authorUserId: e.authorUserId,
    authorDeviceId: e.authorDeviceId,
    data,
    undelivered: e.localMetadata === UNDELIVERED_METADATA,
  };
}
