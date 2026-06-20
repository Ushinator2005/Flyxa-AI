import { describe, expect, it } from 'vitest';
import { normalizeConfluenceTag, normalizeConfluenceTags } from './confluenceTags.js';

describe('confluence tag normalization', () => {
  it('ignores case and whitespace for equivalent tags', () => {
    expect(normalizeConfluenceTags(['Displacement', 'DISPLACEMENT', 'Dis placement'])).toEqual([
      'Displacement',
    ]);
    expect(normalizeConfluenceTags(['Orderblock', 'order block'])).toEqual([
      'LTF Orderblock',
    ]);
  });

  it('migrates known typo aliases', () => {
    expect(normalizeConfluenceTag('IIFVG')).toBe('IFVG');
    expect(normalizeConfluenceTag('Reabalance')).toBe('Rebalance');
  });
});
