import type { Entry } from '../merge';
import { indexReceipts, seenEntryId, viewedAtFor } from '../seen';

const ALICE = 'uAlice';
const BOB = 'uBob';
const CONV = [ALICE, BOB].sort().join('_');

const message: Entry = {
  id: 'dm_1', sentAt: 1_000, authorUserId: ALICE, authorDeviceId: 'd_alice',
  data: { conversationId: CONV, content: 'hi' },
};

function receipt(
  over: Record<string, unknown> = {}, sentAt = 5_000, id = seenEntryId('directMessage', 'dm_1'), author = BOB,
): Entry {
  return {
    id, sentAt, authorUserId: author, authorDeviceId: 'd_bob',
    data: { conversationId: CONV, viewedAt: 4_000, ...over },
  };
}

describe('viewedAtFor', () => {
  it('is null without a receipt', () => {
    expect(viewedAtFor('directMessage', message, indexReceipts([]))).toBeNull();
  });

  it("uses the other participant's receipt", () => {
    expect(viewedAtFor('directMessage', message, indexReceipts([receipt()]))).toBe(4_000);
  });

  it('ignores a receipt written by the entry author, so a sender cannot mark their own message seen', () => {
    expect(viewedAtFor('directMessage', message, indexReceipts([receipt({}, 5_000, undefined, ALICE)]))).toBeNull();
  });

  it('ignores a receipt naming a different conversation', () => {
    expect(viewedAtFor('directMessage', message, indexReceipts([receipt({ conversationId: 'uBob_uEve' })]))).toBeNull();
  });

  it('caps a future-dated viewedAt at the receipt sentAt', () => {
    expect(viewedAtFor('directMessage', message, indexReceipts([receipt({ viewedAt: 9_999_999 }, 5_000)]))).toBe(5_000);
  });

  it('does not apply a pix receipt to a message with the same id', () => {
    const pixReceipt = receipt({}, 5_000, seenEntryId('pix', 'dm_1'));
    expect(viewedAtFor('directMessage', message, indexReceipts([pixReceipt]))).toBeNull();
  });
});
