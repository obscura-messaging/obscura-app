/**
 * Planning an inbox drain (`docs/DOMAIN_CONTRACT.md`, "Drain").
 *
 * ```
 * for each row: classify → validate → AUTHORIZE → attribute → merge → write → consume | discard
 * ```
 *
 * - Authorize before storing: any authenticated user can deliver to any device.
 * - Consume only what was written. The inbox row is the only copy, so consuming first loses it.
 * - Discard what can never be processed. There is no skip cursor, so a skipped row would block the
 *   queue forever.
 *
 * Pure: takes rows and current state, returns a plan. `src/state/drainInbox.ts` applies it.
 */

import { parseConversationId } from './conversation';
import { merge, type Entry, type MergeRule } from './merge';
import { invalidFields, type FieldType } from './fields';
import { erasedKey } from './expiry';

/** The kit's inbox row, narrowed to what the drain actually reads. */
export interface DrainRow {
  id: number;
  kind: string;
  modelKey: string | null;
  entryId: string | null;
  sentAt: number | null;
  /**
   * The sending **user**, stamped by transport and accepted after Signal decryption.
   */
  senderUserId: string;
  /** The device whose Signal session decrypted this — cryptographic attribution, and the tie-break. */
  senderDeviceId: string | null;
  payload: string;
}

/** Why a row could not be processed. Carried into `discard(ids, reason)` and the security log. */
export type DiscardReason =
  | 'unknown-kind'
  | 'unknown-model'
  | 'missing-fields'
  | 'invalid-fields'
  | 'unparsable-payload'
  | 'unauthorized-sender';

/**
 * What the app knows about a model, as the drain needs it.
 *
 * The two optional rules are this app's **authorization** policy — the answer to "may *this* sender
 * write *this* entry". They are optional because they are not universal: `story` has neither, and
 * that is a real gap rather than an oversight (see `authorize`).
 */
export interface ModelRules {
  merge: MergeRule;
  /** Declared field types; entries that do not match are discarded. */
  fields: Readonly<Record<string, FieldType>>;
  /**
   * The payload field naming a 1:1 conversation. Set for conversation-scoped models: the id must be
   * canonical two-party and must name **both** this user and the authenticated sender.
   */
  conversationField?: string;
  /**
   * An entry-id prefix that binds an entry to its owner: the id MUST be
   * `${ownerIdPrefix}${senderUserId}`. Set for `profile`, whose id is guessable by construction.
   */
  ownerIdPrefix?: string;
}

/**
 * May this authenticated sender write this entry? `null` when yes.
 *
 * Friendship is not required: gating a permanent discard on a friend graph that updates through a
 * different message would drop real mail on the accept/first-message race. The screens resolve
 * names through the friend graph, so a stranger's entry is stored but never attributed.
 *
 * `story` has no rule beyond attribution: it carries no id or field that binds it
 * to an author, so the authenticated sender becomes the author.
 */
function authorize(
  row: DrainRow,
  rules: ModelRules,
  data: Record<string, unknown>,
  selfUserId: string,
): DiscardReason | null {
  if (rules.ownerIdPrefix !== undefined && row.entryId !== rules.ownerIdPrefix + row.senderUserId) {
    return 'unauthorized-sender';
  }

  if (rules.conversationField !== undefined) {
    const raw = data[rules.conversationField];
    if (typeof raw !== 'string') return 'unauthorized-sender';
    // FORMAT, owned by `conversation.ts` and shared with the send side (`audience.ts`) so the two
    // directions cannot disagree about what a conversation id is.
    const participants = parseConversationId(raw);
    if (participants === null) return 'unauthorized-sender';
    // MEMBERSHIP, and it is stricter here than on the send side: the two participants must be ME and
    // the person who actually sent this. A conversation between two other people is not mine to
    // store, and a conversation between me and Alice is not something a stranger may write into.
    if (!participants.includes(selfUserId)) return 'unauthorized-sender';
    if (!participants.includes(row.senderUserId)) return 'unauthorized-sender';
  }

  return null;
}

export interface DrainPlan {
  /** Entries to write, grouped by model. Already merged against current state. */
  writes: Map<string, Entry[]>;
  /** Row ids safe to consume — every one of them is represented in `writes`. */
  consume: number[];
  /** Row ids that can never be processed, with the reason. Data loss, chosen out loud. */
  discard: Array<{ id: number; reason: DiscardReason }>;
}

/**
 * Decide what to do with a batch of inbox rows.
 *
 * `knownModels` is the app's schema: a `modelKey` outside it comes from a newer peer and cannot be
 * stored, because the app has nowhere to put it and no way to render it.
 *
 * `state` is the current entries per model, keyed by entry id — the merge input. It is not mutated.
 *
 * `selfUserId` is this device's authenticated user. It is required, not optional: the conversation
 * rule is meaningless without it, and defaulting it to `''` would silently authorize everything.
 *
 * `erased` holds `erasedKey(model, id)` for entries this device has erased (`domain/expiry.ts`). A
 * later write for one is consumed without being stored, so a replay cannot bring it back.
 */
export function planDrain(
  rows: readonly DrainRow[],
  knownModels: ReadonlyMap<string, ModelRules>,
  state: ReadonlyMap<string, ReadonlyMap<string, Entry>>,
  selfUserId: string,
  erased: ReadonlySet<string> = new Set(),
): DrainPlan {
  const plan: DrainPlan = { writes: new Map(), consume: [], discard: [] };
  // Merge accumulates within the batch too: two rows touching one entry id must resolve against
  // each other, not just against what was already stored. Otherwise the second silently wins on
  // arrival order rather than on the merge rule.
  const working = new Map<string, Map<string, Entry>>();

  for (const row of rows) {
    // Not an app entry; the app cannot read it either.
    if (row.kind !== 'APP_ENTRY') {
      plan.discard.push({ id: row.id, reason: 'unknown-kind' });
      continue;
    }

    // A newer peer's model. Not corrupt, just unreadable here.
    if (row.modelKey === null || !knownModels.has(row.modelKey)) {
      plan.discard.push({ id: row.id, reason: 'unknown-model' });
      continue;
    }

    // `senderDeviceId` is the REPLACE tie-break; without it devices could converge differently.
    // `senderUserId` is the authorization and attribution input.
    if (
      row.entryId === null || row.sentAt === null ||
      row.senderDeviceId === null || row.senderUserId === ''
    ) {
      plan.discard.push({ id: row.id, reason: 'missing-fields' });
      continue;
    }

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('payload is not a JSON object');
      }
      data = parsed as Record<string, unknown>;
    } catch {
      // A peer sent something this app cannot read. Not a crash and not a retry: retrying parses the
      // same bytes to the same failure forever, which is exactly how a drain wedges.
      plan.discard.push({ id: row.id, reason: 'unparsable-payload' });
      continue;
    }

    const model = row.modelKey;
    const rules = knownModels.get(model)!;

    if (invalidFields(rules.fields, data).length > 0) {
      plan.discard.push({ id: row.id, reason: 'invalid-fields' });
      continue;
    }

    const unauthorized = authorize(row, rules, data, selfUserId);
    if (unauthorized !== null) {
      plan.discard.push({ id: row.id, reason: unauthorized });
      continue;
    }

    if (erased.has(erasedKey(model, row.entryId))) {
      plan.consume.push(row.id);
      continue;
    }

    const current = working.get(model) ?? new Map(state.get(model) ?? new Map());

    // The author is the authenticated sender, never a payload field.
    const entry: Entry = {
      id: row.entryId,
      sentAt: row.sentAt,
      authorUserId: row.senderUserId,
      authorDeviceId: row.senderDeviceId,
      data,
    };

    const next = merge(rules.merge, current, [entry]);
    working.set(model, next);
    plan.consume.push(row.id);

    // Record the write only if the merge actually took this entry. An APPEND duplicate, or a REPLACE
    // that lost on `(sentAt, authorDeviceId)`, changes nothing — writing it anyway would overwrite
    // the winner with the loser, because `entryPut` is a blind upsert. The row is
    // still consumed: it was processed correctly, and the correct outcome was "keep what we have".
    if (next.get(entry.id) === entry) {
      const writes = plan.writes.get(model) ?? [];
      // Last write for an id wins within a batch — `next` already resolved the order, so replacing
      // an earlier queued write for the same id keeps one `entryPut` per entry rather than several.
      const existingIndex = writes.findIndex((w) => w.id === entry.id);
      if (existingIndex >= 0) writes[existingIndex] = entry;
      else writes.push(entry);
      plan.writes.set(model, writes);
    }
  }

  return plan;
}
