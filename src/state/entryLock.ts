/**
 * Serialises every writer of the entry store. `entryPut` is a blind upsert, so a write landing between
 * another writer's read and its put is silently reverted: a drain merging against a snapshot would
 * overwrite a seen receipt written meanwhile. One user's writes are few and small, so a mutex costs
 * nothing measurable.
 */

let tail: Promise<unknown> = Promise.resolve();

/** Run `work` after all earlier work settles. A rejection reaches the caller but not the queue. */
export function withEntryLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.catch(() => undefined);
  return result;
}
