/**
 * Canonical conversation IDs, audience resolution, and delivery verification.
 * An audience that cannot be resolved throws; it never widens to a broadcast.
 */

import { acceptedFriends, type Friend } from './friends';

const SEPARATOR = '_';

/** Canonical two-party conversation id: both user ids, sorted, joined by `_`. */
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

/**
 * `friends`: every accepted friend. `conversation`: the other participant of the canonical
 * conversation named by the entry's `conversationId`.
 */
export type Audience = 'friends' | 'conversation';

export class DirectRoutingUnresolved extends Error {
  readonly code = 'DIRECT_ROUTING_UNRESOLVED';

  constructor(reason: string) {
    super(`Refusing to send: ${reason}`);
    this.name = 'DirectRoutingUnresolved';
  }
}

/**
 * The user ids an entry must reach, excluding this user: the kit self-syncs to the author's other
 * devices.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be determined.
 */
export function resolveAudience(
  audience: Audience,
  data: Record<string, unknown>,
  selfUserId: string,
  friends: readonly Friend[],
): string[] {
  const accepted = acceptedFriends(friends).map((f) => f.userId).filter((id) => id !== selfUserId);
  if (audience === 'friends') return accepted;

  const raw = data.conversationId;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DirectRoutingUnresolved('conversationId is missing or empty');
  }
  const participants = parseConversationId(raw);
  if (participants === null) {
    throw new DirectRoutingUnresolved(`'${raw}' is not a canonical two-party conversation id`);
  }
  // The id can come from a peer's payload (a seen receipt echoes it), so it must name me, and only
  // accepted friends among the participants are reached.
  if (!participants.includes(selfUserId)) {
    throw new DirectRoutingUnresolved(`'${raw}' does not name this user`);
  }
  return participants.filter((id) => accepted.includes(id));
}

/** `accepted` means queued by the server. A null `deviceId` is a user-level result. */
export interface SubmissionResult {
  userId: string;
  deviceId: string | null;
  status: 'accepted' | 'rejected' | 'unknown';
  error: string | null;
}

export interface SendReport {
  recipients: SubmissionResult[];
  /** The author's own other devices. */
  selfSync: SubmissionResult[];
}

/**
 * Whether a send reached anyone: true when it named nobody or any recipient device accepted it. The
 * author's own devices do not count.
 */
export function reachedRecipients(recipients: readonly string[], report: SendReport): boolean {
  return recipients.length === 0 || report.recipients.some((r) => r.status === 'accepted');
}

/** A send that reached none of its recipients. */
export class SendFailed extends Error {
  readonly code = 'SEND_FAILED';

  constructor(model: string, report: SendReport) {
    const reasons = report.recipients.map((r) => r.error ?? r.status).join('; ');
    super(`${model} reached none of its recipients${reasons ? `: ${reasons}` : ''}`);
    this.name = 'SendFailed';
  }
}
