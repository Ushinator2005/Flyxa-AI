import { describe, expect, it } from 'vitest';
import { normalizeBehavioralFlags } from './behavioralFlags.js';

describe('normalizeBehavioralFlags', () => {
  it('migrates the replaced unplanned-trade flag', () => {
    expect(normalizeBehavioralFlags(['off-playbook'])).toEqual(['incorrect-stop-loss']);
  });

  it('normalizes and deduplicates flag values', () => {
    expect(normalizeBehavioralFlags([
      ' Incorrect-Stop-Loss ',
      'incorrect-stop-loss',
      'revenge',
    ])).toEqual(['incorrect-stop-loss', 'revenge']);
  });
});
