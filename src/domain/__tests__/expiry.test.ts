import {
  ERASED_MODEL, EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS, erasedKey, expiresAt, planSweep,
  storyExpiresAt, type SweepInput,
} from '../expiry';
import type { Entry } from '../merge';
import { SEEN_MODEL, seenEntryId } from '../seen';

describe('expiresAt', () => {
  it('is EXPIRE_AFTER_MS after the entry was seen', () => {
    expect(expiresAt(1_000, 5_000)).toBe(5_000 + EXPIRE_AFTER_MS);
  });

  it('caps an unseen entry at MAX_AGE_MS after it was sent', () => {
    expect(expiresAt(1_000, null)).toBe(1_000 + MAX_AGE_MS);
  });

  it('never lets a late view extend an entry past MAX_AGE_MS', () => {
    expect(expiresAt(1_000, 1_000 + MAX_AGE_MS)).toBe(1_000 + MAX_AGE_MS);
  });
});

describe('storyExpiresAt', () => {
  it('is STORY_MAX_AGE_MS after the story was posted', () => {
    expect(storyExpiresAt(1_000)).toBe(1_000 + STORY_MAX_AGE_MS);
  });

  it('is one day, well inside the ceiling for seen entries', () => {
    expect(STORY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(STORY_MAX_AGE_MS).toBeLessThan(MAX_AGE_MS);
  });
});

describe('erasedKey', () => {
  it('distinguishes the same id in different models', () => {
    expect(erasedKey('pix', 'x')).not.toBe(erasedKey('directMessage', 'x'));
  });
});

describe('planSweep', () => {
  const NOW = 100 * MAX_AGE_MS;
  const CONV = 'a_b';
  const entry = (id: string, sentAt: number, data: Record<string, unknown> = {}, authorUserId = 'a'): Entry =>
    ({ id, sentAt, authorUserId, authorDeviceId: 'd', data: { conversationId: CONV, ...data } });
  const receipt = (model: string, id: string, viewedAt: number): Entry =>
    entry(seenEntryId(model, id), viewedAt, { viewedAt }, 'b');
  const plan = (over: Partial<SweepInput>) => planSweep({
    now: NOW, ephemeral: new Map(), stories: [], receipts: [], markers: [], ...over,
  });

  it('expires a seen entry with its receipt and media, marking both', () => {
    const result = plan({
      ephemeral: new Map([['pix', [entry('p', NOW - 1, { mediaRef: 'att' })]]]),
      receipts: [receipt('pix', 'p', NOW - EXPIRE_AFTER_MS)],
    });

    expect(result).toEqual({
      purge: ['att'],
      mark: [erasedKey('pix', 'p'), erasedKey(SEEN_MODEL, seenEntryId('pix', 'p'))],
      erase: new Map([['pix', ['p']], [SEEN_MODEL, [seenEntryId('pix', 'p')]]]),
      touched: ['pix'],
    });
  });

  it('keeps unseen and recently seen entries', () => {
    const result = plan({
      ephemeral: new Map([['directMessage', [entry('new', NOW - 1), entry('seen', NOW - 1)]]]),
      receipts: [receipt('directMessage', 'seen', NOW - 1)],
    });

    expect(result.erase.size).toBe(0);
    expect(result.touched).toEqual([]);
  });

  it('expires a story by its age alone', () => {
    const result = plan({ stories: [entry('old', NOW - STORY_MAX_AGE_MS), entry('new', NOW - 1)] });

    expect(result.erase).toEqual(new Map([['story', ['old']]]));
    expect(result.mark).toEqual([erasedKey('story', 'old')]);
  });

  it('erases old orphan receipts and old markers without marking them', () => {
    const result = plan({
      receipts: [receipt('pix', 'never-arrived', NOW - MAX_AGE_MS)],
      markers: [{ id: 'm_old', sentAt: NOW - MAX_AGE_MS }, { id: 'm_new', sentAt: NOW - 1 }],
    });

    expect(result.mark).toEqual([]);
    expect(result.erase).toEqual(new Map([
      [SEEN_MODEL, [seenEntryId('pix', 'never-arrived')]],
      [ERASED_MODEL, ['m_old']],
    ]));
  });
});
