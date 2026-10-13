/**
 * Planning an inbox drain (`docs/DOMAIN_CONTRACT.md`, "Drain"). Pure; `state/drainInbox.ts` applies
 * the plan.
 */

import type { InboxRow } from '../native/ObscuraModule';
import { parseConversationId } from './conversation';
import { merge, type Entry } from './merge';
import { invalidFields } from './fields';
import { erasedKey } from './expiry';
import type { ModelDeclaration } from './model';

/** Why a row could not be processed. Carried into `inboxDiscard` and the log. */
export type DiscardReason =
  | 'unknown-kind'
  | 'unknown-model'
  | 'missing-fields'
  | 'invalid-fields'
  | 'unparsable-payload'
  | 'unauthorized-sender';

/**
 * May this authenticated sender write this entry? Friendship is not required: gating a permanent
 * discard on the friend graph would drop real mail when an accept races the first message.
 */
function authorize(
  row: InboxRow,
  rules: ModelDeclaration,
  data: Record<string, unknown>,
  selfUserId: string,
): DiscardReason | null {
  if (rules.ownerIdPrefix !== undefined && row.entryId !== rules.ownerIdPrefix + row.senderUserId) {
    return 'unauthorized-sender';
  }
  if (rules.audience === 'conversation') {
    const raw = data.conversationId;
    const participants = typeof raw === 'string' ? parseConversationId(raw) : null;
    if (
      participants === null ||
      !participants.includes(selfUserId) ||
      !participants.includes(row.senderUserId)
    ) {
      return 'unauthorized-sender';
    }
  }
  return null;
}

function parseObject(payload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface DrainPlan {
  /** Entries to write per model, already merged against current state. */
  writes: Map<string, Entry[]>;
  /** Rows safe to consume once `writes` is stored. */
  consume: number[];
  /** Rows that can never be processed. */
  discard: Array<{ id: number; reason: DiscardReason }>;
}

/**
 * Decide what to do with a batch of inbox rows.
 *
 * `state` holds the stored entries the batch names, per model and id. `erased` holds the
 * `erasedKey`s of entries this device erased; a write for one is consumed without being stored.
 */
export function planDrain(
  rows: readonly InboxRow[],
  knownModels: ReadonlyMap<string, ModelDeclaration>,
  state: ReadonlyMap<string, ReadonlyMap<string, Entry>>,
  selfUserId: string,
  erased: ReadonlySet<string> = new Set(),
): DrainPlan {
  const plan: DrainPlan = { writes: new Map(), consume: [], discard: [] };
  // Rows in one batch that touch the same entry must merge against each other, not just the store.
  const working = new Map<string, Map<string, Entry>>();
  const discard = (id: number, reason: DiscardReason) => plan.discard.push({ id, reason });

  for (const row of rows) {
    if (row.kind !== 'APP_ENTRY') { discard(row.id, 'unknown-kind'); continue; }

    const rules = row.modelKey === null ? undefined : knownModels.get(row.modelKey);
    if (row.modelKey === null || rules === undefined) { discard(row.id, 'unknown-model'); continue; }

    if (
      row.entryId === null || row.sentAt === null ||
      row.senderDeviceId === null || row.senderUserId === ''
    ) {
      discard(row.id, 'missing-fields');
      continue;
    }

    // Retrying an unreadable payload fails the same way forever, so it is discarded, not kept.
    const data = parseObject(row.payload);
    if (data === null) { discard(row.id, 'unparsable-payload'); continue; }

    if (invalidFields(rules.fields, data).length > 0) { discard(row.id, 'invalid-fields'); continue; }

    const unauthorized = authorize(row, rules, data, selfUserId);
    if (unauthorized !== null) { discard(row.id, unauthorized); continue; }

    const model = row.modelKey;
    plan.consume.push(row.id);
    if (erased.has(erasedKey(model, row.entryId))) continue;

    const entry: Entry = {
      id: row.entryId,
      sentAt: row.sentAt,
      authorUserId: row.senderUserId,
      authorDeviceId: row.senderDeviceId,
      data,
    };
    const next = merge(rules.merge, working.get(model) ?? state.get(model) ?? new Map(), [entry]);
    working.set(model, next);

    // A merge loser is consumed but not written: `entryPut` is blind and would overwrite the winner.
    if (next.get(entry.id) === entry) {
      const writes = (plan.writes.get(model) ?? []).filter((w) => w.id !== entry.id);
      plan.writes.set(model, [...writes, entry]);
    }
  }

  return plan;
}
