import { reachedRecipients } from '../delivery';
import type { SubmissionResult } from '../../native/ObscuraModule';

const result = (userId: string, status: SubmissionResult['status']): SubmissionResult =>
  ({ userId, deviceId: `${userId}-d`, status, error: null });

describe('reachedRecipients', () => {
  it('is true when any recipient device accepted', () => {
    expect(reachedRecipients(['a', 'b'], { recipients: [result('a', 'rejected'), result('b', 'accepted')], selfSync: [] })).toBe(true);
  });

  it('is false when none did, however many own devices accepted', () => {
    expect(reachedRecipients(['a'], { recipients: [result('a', 'unknown')], selfSync: [result('me', 'accepted')] })).toBe(false);
  });

  it('is true for a send that names nobody', () => {
    expect(reachedRecipients([], { recipients: [], selfSync: [] })).toBe(true);
  });
});
