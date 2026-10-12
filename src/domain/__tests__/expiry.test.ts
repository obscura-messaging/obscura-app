import {
  EXPIRE_AFTER_MS, MAX_AGE_MS, STORY_MAX_AGE_MS, erasedKey, expiresAt, storyExpiresAt,
} from '../expiry';

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
