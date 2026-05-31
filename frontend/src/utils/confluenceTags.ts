/**
 * confluenceTags.ts
 *
 * Single source of truth for confluence tag aliases.
 * Used by the store (normalises stored trade data at read time)
 * and by Settings (normalises user input at write time).
 */

const CONFLUENCE_ALIASES: Array<[canonical: string, aliases: string[]]> = [
  ['Liquidity sweep',        ['liq sweep', 'liq. sweep', 'liquidity sweeps', 'sweep liq', 'ssl sweep', 'bsl sweep', 'inducement sweep', 'sweep']],
  ['Market structure shift', ['mss', 'ms shift', 'structure shift', 'msb', 'market structure break', 'market structure']],
  ['Break of structure',     ['bos', 'break of str', 'structure break', 'break of struc']],
  ['Change of character',    ['choch', 'cho ch', 'choc', 'change of char']],
  ['Order block',            ['ob', 'ob retest', 'order block retest', 'ob tap', 'order block tap', 'obs', 'mitigation block']],
  ['Breaker block',          ['breaker', 'bb', 'breaker ob']],
  ['Fair value gap',         ['fvg', 'imbalance', 'imb', 'fair value gaps', 'price gap', 'inefficiency', 'gap']],
  ['Rejection block',        ['rej block', 'rejection ob']],
  ['VWAP reclaim',           ['vwap', 'vwap retest', 'vwap rejection', 'vwap reject', 'vwap level']],
  ['HTF bias',               ['htf', 'htf bias', 'higher timeframe', 'higher tf', 'higher time frame', 'htf alignment', 'daily bias', 'weekly bias']],
  ['LTF confirmation',       ['ltf', 'ltf entry', 'lower timeframe', 'lower tf']],
  ['Session high/low sweep', ['session sweep', 'session high sweep', 'session low sweep', 'asia sweep', 'london sweep', 'ny sweep', 'session hl']],
  ['Volume confirmation',    ['volume', 'vol', 'vol conf', 'volume spike', 'high volume']],
  ['Kill zone',              ['killzone', 'kill zones', 'kz', 'ny kz', 'london kz', 'asia kz', 'ny killzone', 'london killzone']],
  ['OTE',                    ['optimal trade entry', 'ote level', 'optimal entry']],
  ['PD array',               ['pd arrays', 'pd', 'premium/discount', 'premium discount', 'premium array']],
  ['Point of control',       ['poc', 'p.o.c', 'value area']],
  ['Equilibrium',            ['eq', 'equilib', '50% level', 'midpoint']],
  ['Supply zone',            ['supply', 'supply area', 'supply ob', 'supply level']],
  ['Demand zone',            ['demand', 'demand area', 'demand ob', 'demand level']],
  ['Trend alignment',        ['trend', 'with trend', 'trend follow', 'trend continuation']],
  ['Key level',              ['key sr', 'key support', 'key resistance', 'key s/r', 'key level retest', 'strong level']],
];

const CONFLUENCE_CANONICAL_MAP = (() => {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of CONFLUENCE_ALIASES) {
    map.set(canonical.toLowerCase(), canonical);
    for (const alias of aliases) {
      map.set(alias.toLowerCase(), canonical);
    }
  }
  return map;
})();

/** Resolves a raw tag to its canonical display name, or returns it unchanged if unknown. */
export function normalizeConfluenceTag(raw: string): string {
  const trimmed = raw.trim();
  return CONFLUENCE_CANONICAL_MAP.get(trimmed.toLowerCase()) ?? trimmed;
}

export { CONFLUENCE_ALIASES };
