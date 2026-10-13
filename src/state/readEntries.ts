import { Obscura, type StoredEntry } from '../native/ObscuraModule';
import type { Entry } from '../domain/merge';
import { logError } from '../utils/log';

export interface StoredRow extends Entry {
  localMetadata: string | null;
}

/** A model's stored entries with `data` parsed. Rows that are not a JSON object are logged and skipped. */
export async function readEntries(model: string): Promise<StoredRow[]> {
  return parseRows(model, await Obscura.entryAll(model));
}

/** The named entries that exist, parsed like `readEntries`. */
export async function readEntriesById(model: string, ids: readonly string[]): Promise<StoredRow[]> {
  return ids.length === 0 ? [] : parseRows(model, await Obscura.entryGet(model, [...ids]));
}

function parseRows(model: string, entries: readonly StoredEntry[]): StoredRow[] {
  const rows: StoredRow[] = [];
  for (const e of entries) {
    let data: unknown;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      logError('entries.parse:' + model, err);
      continue;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      logError('entries.parse:' + model, new Error(`entry ${e.id} is not a JSON object`));
      continue;
    }
    rows.push({
      id: e.id,
      sentAt: e.sentAt,
      authorDeviceId: e.authorDeviceId,
      data: data as Record<string, unknown>,
      localMetadata: e.localMetadata,
    });
  }
  return rows;
}
