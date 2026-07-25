// Canonical Flyxa palette for pages that style with inline constants rather
// than CSS variables. These now resolve to the themed design tokens, so a page
// using C flips correctly in light mode; the dark-mode values are unchanged.
// If you need a new tone, add it here (pointing at a token), not a page copy.
export const C = {
  d0: 'var(--color-bg)', d1: 'var(--color-bg-muted)', d2: 'var(--color-panel)', d3: 'var(--color-panel-raised)', d4: 'var(--color-panel-raised)',
  b0: 'var(--color-border)', b1: 'var(--color-border)',
  t0: 'var(--color-text)', t1: 'var(--color-text-muted)', t2: 'var(--color-text-subtle)',
  acc: 'var(--color-amber)', amb: 'var(--color-amber)', grn: 'var(--color-green)', red: 'var(--color-red)',
  mono: "'DM Mono', ui-monospace, monospace",
};
