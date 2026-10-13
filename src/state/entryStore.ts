import { Obscura, type StoredEntry } from '../native/ObscuraModule';
import type { Entry } from '../domain/merge';
import { logError } from '../utils/log';

/**
 * The only module that knows how an entry is stored in the kit.
 *
 * The kit stores `data` as an opaque string with no author column, so the authenticated author
 * travels inside it under `_authorUserId`. Outside this module an entry's author is
 * `Entry.authorUserId` and its `data` is exactly what peers send.
 */

const AUTHOR_KEY = '_authorUserId';

export interface StoredRow extends Entry {
  localMetadata: string | null;
}

/** A model's stored entries. Rows that do not decode are logged and skipped. */
export async function readEntries(model: string): Promise<StoredRow[]> {
  return decodeAll(model, await Obscura.entryAll(model));
}

/** The named entries that exist, decoded like `readEntries`. */
export async function readEntriesById(model: string, ids: readonly string[]): Promise<StoredRow[]> {
  return ids.length === 0 ? [] : decodeAll(model, await Obscura.entryGet(model, [...ids]));
}

/** Store an entry. A blind upsert: callers merge first. */
export function putEntry(model: string, entry: Entry, localMetadata: string | null = null): Promise<void> {
  return Obscura.entryPut(
    model,
    entry.id,
    JSON.stringify({ ...entry.data, [AUTHOR_KEY]: entry.authorUserId }),
    entry.sentAt,
    entry.authorDeviceId,
    localMetadata,
  );
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
    localMetadata: e.localMetadata,
  };
}
