// Instant-breaking keyword brain for the news terminal. A headline matching
// any of these gets BREAKING treatment the moment it lands — before the AI
// filter returns. User-editable in the terminal's Sources panel; these are
// the defaults and the reset target.

export const DEFAULT_HOT_KEYWORDS: string[] = [
  'trump', 'white house', 'biden', 'tariff', 'sanction', 'war', 'invasion',
  'strike', 'missile', 'nuclear', 'attack', 'explosion', 'emergency',
  'fed', 'fomc', 'powell', 'rate cut', 'rate hike', 'cpi', 'ppi', 'nfp',
  'payrolls', 'inflation', 'halt', 'crash', 'default',
];

const MAX_KEYWORDS = 60;
const MAX_KEYWORD_LENGTH = 40;

/** Parse a comma/newline-separated string into a clean keyword list. */
export function parseHotKeywords(value: string): string[] {
  return normalizeHotKeywords(value.split(/[,\n]/));
}

export function normalizeHotKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_HOT_KEYWORDS];
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim().toLowerCase().slice(0, MAX_KEYWORD_LENGTH);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    keywords.push(cleaned);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile the keyword list into one word-boundary regex. Returns null for an
 * empty list (user cleared everything = instant-breaking disabled).
 */
export function buildHotRegex(keywords: string[]): RegExp | null {
  const cleaned = keywords.map(escapeRegex).filter(Boolean);
  if (cleaned.length === 0) return null;
  return new RegExp(`\\b(?:${cleaned.join('|')})\\b`, 'i');
}
