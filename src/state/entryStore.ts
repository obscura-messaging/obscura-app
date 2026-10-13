import { Obscura, type StoredEntry } from '../native/ObscuraModule';
import { ERASED_MODEL } from '../domain/expiry';
import type { Entry } from '../domain/merge';
import { logError } from '../utils/log';

/**
 * The only module that knows how entries are stored in the kit.
 *
 * The kit has no author column, so the author travels inside `data` under `_authorUserId`, and the
 * outbox mark travels in `localMetadata`. Outside this module an entry's `data` is exactly what
 * peers send.
 */

const AUTHOR_KEY = '_authorUserId';
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
    JSON.stringify({ ...entry.data, [AUTHOR_KEY]: entry.authorUserId }),
    entry.sentAt,
    entry.authorDeviceId,
    undelivered ? UNDELIVERED_METADATA : null,
  );
}

/** Record an erased entry's `erasedKey`, so a replayed write for it is not stored again. */
export function putErasedMarker(key: string, erasedAt: number): Promise<void> {
  return Obscura.entryPut(ERASED_MODEL, key, '{}', erasedAt, '', null);
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
  const parsed: unknown = JSON.parse(e.data);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`entry ${e.id} is not a JSON object`);
  }
  const { [AUTHOR_KEY]: authorUserId, ...data } = parsed as Record<string, unknown>;
  if (typeof authorUserId !== 'string' || authorUserId === '') {
    throw new Error(`entry ${e.id} has no author`);
  }
  return {
    id: e.id,
    sentAt: e.sentAt,
    authorUserId,
    authorDeviceId: e.authorDeviceId,
    data,
    undelivered: e.localMetadata === UNDELIVERED_METADATA,
  };
}
