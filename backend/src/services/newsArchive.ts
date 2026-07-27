import { supabase } from './supabase';

// Headline archive — every headline the backend touches is persisted so the
// terminal can search history. Writes are fire-and-forget and fail open: a
// missing table (migration 026 not applied) must never break the live wire.

export interface ArchivableNewsItem {
  headline: string;
  source?: string;
  timestamp?: string;
  summary?: string;
  url?: string;
  impact?: 'high' | 'medium' | 'low';
  isBreaking?: boolean;
}

// Skip rows we've already written this process lifetime so the 60-second
// polling loop doesn't hammer the table with duplicate upserts.
const seenKeys = new Set<string>();
const SEEN_MAX = 4000;
let warnedUnavailable = false;

function keyFor(publishedAt: string, headline: string): string {
  return `${publishedAt}|${headline.slice(0, 120)}`;
}

function toRow(item: ArchivableNewsItem) {
  const publishedAt = item.timestamp && !Number.isNaN(new Date(item.timestamp).getTime())
    ? new Date(item.timestamp).toISOString()
    : new Date().toISOString();
  return {
    headline: item.headline.slice(0, 500),
    source: item.source ?? '',
    url: item.url ?? null,
    summary: item.summary?.slice(0, 1000) ?? null,
    impact: item.impact ?? null,
    is_breaking: item.isBreaking === true,
    published_at: publishedAt,
  };
}

/**
 * Persist raw headlines (no classification yet). Duplicate (published_at,
 * headline) rows are ignored, so re-ingesting a cached wire batch is a no-op.
 */
export function archiveNewsItems(items: ArchivableNewsItem[]): void {
  void archive(items, { updateClassification: false });
}

/**
 * Persist AI-classified headlines — upserts so impact/is_breaking overwrite
 * the null classification of the raw ingest row.
 */
export function archiveClassifiedNews(items: ArchivableNewsItem[]): void {
  void archive(items, { updateClassification: true });
}

async function archive(items: ArchivableNewsItem[], options: { updateClassification: boolean }): Promise<void> {
  try {
    const rows = items
      .filter(item => typeof item.headline === 'string' && item.headline.trim().length > 0)
      .map(toRow)
      .filter(row => {
        const key = `${options.updateClassification ? 'c' : 'r'}:${keyFor(row.published_at, row.headline)}`;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });
    if (rows.length === 0) return;
    if (seenKeys.size > SEEN_MAX) {
      // Drop the oldest half; Set preserves insertion order.
      let index = 0;
      for (const key of seenKeys) {
        seenKeys.delete(key);
        if (++index >= SEEN_MAX / 2) break;
      }
    }

    const { error } = await supabase
      .from('news_archive')
      .upsert(rows, {
        onConflict: 'published_at,headline',
        ignoreDuplicates: !options.updateClassification,
      });
    if (error && !warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('[newsArchive] archive write failed (apply migration 026_create_news_archive.sql):', error.message);
    }
  } catch (err) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn('[newsArchive] archive write failed:', err);
    }
  }
}

export interface NewsArchiveQuery {
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function searchNewsArchive(query: NewsArchiveQuery): Promise<{
  items: Array<{ headline: string; source: string; url: string | null; impact: string | null; is_breaking: boolean; published_at: string }>;
  available: boolean;
}> {
  try {
    const limit = Math.min(200, Math.max(1, Math.round(query.limit ?? 50)));
    let builder = supabase
      .from('news_archive')
      .select('headline,source,url,impact,is_breaking,published_at')
      .order('published_at', { ascending: false })
      .limit(limit);
    const q = (query.q ?? '').trim().slice(0, 80);
    // Escape LIKE wildcards so a search for "100%" behaves literally.
    if (q) builder = builder.ilike('headline', `%${q.replace(/[%_]/g, '\\$&')}%`);
    if (query.from) builder = builder.gte('published_at', query.from);
    if (query.to) builder = builder.lte('published_at', query.to);
    const { data, error } = await builder;
    if (error) return { items: [], available: false };
    return { items: data ?? [], available: true };
  } catch {
    return { items: [], available: false };
  }
}
