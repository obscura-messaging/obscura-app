/**
 * Whether a send reached anyone (`docs/DOMAIN_CONTRACT.md`, "Local writes").
 *
 * The kit reports per-device outcomes and never throws because nobody received a message. The app's
 * rule stays what it was: a send fails when it named people and none of their devices accepted it.
 * The author's own devices do not count, because a message that only reached my other phone reached
 * nobody. A partial delivery is a success.
 */

import type { SendReport } from '../native/ObscuraModule';

export function reachedRecipients(recipients: readonly string[], report: SendReport): boolean {
  return recipients.length === 0 || report.recipients.some((r) => r.status === 'accepted');
}

/** A send that reached none of its recipients. The entry is stored and marked for retry. */
export class SendFailed extends Error {
  readonly code = 'SEND_FAILED';

  constructor(model: string, report: SendReport) {
    const reasons = report.recipients.map((r) => r.error ?? r.status).join('; ');
    super(`${model} reached none of its recipients${reasons ? `: ${reasons}` : ''}`);
    this.name = 'SendFailed';
  }
}
