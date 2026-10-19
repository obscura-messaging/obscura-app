/**
 * The canonical two-party conversation id (`docs/DOMAIN_CONTRACT.md`): both user ids, sorted, joined
 * by `_`. User ids are UUIDs, so they never contain `_`.
 */

const SEPARATOR = '_';

export function conversationId(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(SEPARATOR);
}

/**
 * The two participants of a canonical id, or `null`. A reversed or otherwise noncanonical id is
 * refused rather than interpreted: guessing its audience could mail a 1:1 payload to the wrong
 * person. Membership is for the caller to check.
 */
export function parseConversationId(id: string): [string, string] | null {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [first, second] = parts;
  if (first.length === 0 || second.length === 0 || first > second) return null;
  return [first, second];
}
