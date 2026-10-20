/**
 * Who an entry goes to (`docs/DOMAIN_CONTRACT.md`, "Audience"). An audience that cannot be resolved
 * throws; it never widens to a broadcast.
 */

import type { Friend } from '../native/ObscuraModule';
import { parseConversationId } from './conversation';
import { acceptedFriends } from './friends';

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
