import { describe, expect, it } from 'vitest';
import { shouldPreferLocalStore } from './storeFreshness.js';

describe('shouldPreferLocalStore', () => {
  it('prefers a newer local snapshot while cloud sync is still catching up', () => {
    expect(shouldPreferLocalStore(
      String(Date.parse('2026-06-24T02:00:05.000Z')),
      '2026-06-24T02:00:00.000Z',
    )).toBe(true);
  });

  it('keeps the cloud snapshot when it is equally new or newer', () => {
    expect(shouldPreferLocalStore(
      String(Date.parse('2026-06-24T02:00:00.000Z')),
      '2026-06-24T02:00:05.000Z',
    )).toBe(false);
  });

  it('rejects malformed local timestamps', () => {
    expect(shouldPreferLocalStore('not-a-time', '2026-06-24T02:00:05.000Z')).toBe(false);
  });
});
