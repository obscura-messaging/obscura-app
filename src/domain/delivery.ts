import type { SendReport } from '../native/ObscuraModule';

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
