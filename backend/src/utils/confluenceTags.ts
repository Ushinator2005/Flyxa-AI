const ALIASES: Array<[canonical: string, aliases: string[]]> = [
  ['LTF Orderblock', ['orderblock', 'order block', 'ob', 'ob retest', 'order block retest', 'orderblock retest', 'ob tap', 'order block tap', 'orderblock tap', 'obs', 'mitigation block']],
  ['Displacement', ['dis placement']],
  ['IFVG', ['iifvg']],
  ['Rebalance', ['reabalance']],
];

export function normalizeConfluenceKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

const canonicalByKey = (() => {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of ALIASES) {
    map.set(normalizeConfluenceKey(canonical), canonical);
    aliases.forEach(alias => map.set(normalizeConfluenceKey(alias), canonical));
  }
  return map;
})();

export function normalizeConfluenceTag(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  return canonicalByKey.get(normalizeConfluenceKey(cleaned)) ?? cleaned;
}

export function normalizeConfluences(value: unknown, max = Number.POSITIVE_INFINITY): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const canonical = normalizeConfluenceTag(item);
    if (!canonical) continue;
    const key = normalizeConfluenceKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(canonical.slice(0, 64));
    if (normalized.length >= max) break;
  }
  return normalized;
}
