import { describe, expect, it } from 'vitest';
import { parsePreSessionSync } from './preSessionSync.js';

describe('parsePreSessionSync', () => {
  it('accepts a valid cross-window pre-session payload', () => {
    const payload = {
      date: '2026-06-24',
      savedAt: '2026-06-24T01:00:00.000Z',
      nonce: 'sync-1',
      data: {
        emotion: 'Focused',
        note: '',
        bias: {},
        checklistState: { plan: true },
        startedAt: '2026-06-24T00:30:00.000Z',
        readiness: {
          status: 'Ready',
          score: 100,
          summary: 'Ready',
          reasons: [],
        },
      },
    };

    expect(parsePreSessionSync(JSON.stringify(payload))).toEqual(payload);
  });

  it('rejects malformed payloads', () => {
    expect(parsePreSessionSync(null)).toBeNull();
    expect(parsePreSessionSync('{bad json')).toBeNull();
    expect(parsePreSessionSync(JSON.stringify({ date: '2026-06-24' }))).toBeNull();
  });
});
