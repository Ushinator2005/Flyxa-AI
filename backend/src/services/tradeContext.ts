import { supabase } from './supabase';
import { Trade } from '../types/index';

type SessionContext = NonNullable<Trade['sessionContext']>;

// Loose shapes for the frontend store blob — read defensively, never trust fields.
interface StoreEntryTrade {
  pnl?: number;
  pre_trade_notes?: string;
  post_trade_notes?: string;
}
interface StoreEntry {
  date?: string;
  trades?: StoreEntryTrade[];
  reflection?: { pre?: string; post?: string; lessons?: string };
  dailyReflection?: {
    pre?: string;
    post?: string;
    lessons?: string;
    bias?: string | null;
    newsRisk?: string | null;
    sessionTarget?: number | null;
    marketRespectedBias?: boolean | null;
  };
  emotions?: Array<{ label?: string; state?: string }>;
}

export interface ServerTradeContext {
  sessionContext: SessionContext | null;
  voiceContext: string | null;
}

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)} …[clipped]` : text;

const fmtNet = (net: number): string => `${net < 0 ? '−' : '+'}$${Math.abs(Math.round(net)).toLocaleString()}`;

function entryNet(entry: StoreEntry): number {
  return (entry.trades ?? []).reduce((sum, t) => sum + (Number(t?.pnl) || 0), 0);
}

function entryHasWriting(entry: StoreEntry): boolean {
  return Boolean(
    clean(entry.dailyReflection?.pre) || clean(entry.dailyReflection?.post) || clean(entry.dailyReflection?.lessons) ||
    clean(entry.reflection?.pre) || clean(entry.reflection?.post) || clean(entry.reflection?.lessons) ||
    (entry.trades ?? []).some(t => clean(t.pre_trade_notes) || clean(t.post_trade_notes))
  );
}

/**
 * Verbatim writing samples from the trader's recent journal, newest first.
 * Text is passed through untouched — case, punctuation, and typos are the
 * signal the model reads tone from. Also lists traded days with no writing
 * at all, which is itself a strong avoidance/tilt marker.
 */
function buildVoiceContext(entries: StoreEntry[], tradeDate: string): string | null {
  const sorted = entries
    .filter(e => typeof e.date === 'string' && e.date <= tradeDate)
    .sort((a, b) => (b.date as string).localeCompare(a.date as string));

  const rows: string[] = [];
  for (const entry of sorted) {
    if (rows.length >= 10) break;
    const bits: string[] = [];
    const pre = clean(entry.dailyReflection?.pre) || clean(entry.reflection?.pre);
    if (pre) bits.push(`pre-market: "${clip(pre, 350)}"`);
    const post = clean(entry.dailyReflection?.post) || clean(entry.reflection?.post);
    if (post) bits.push(`post-session: "${clip(post, 350)}"`);
    const lessons = clean(entry.dailyReflection?.lessons) || clean(entry.reflection?.lessons);
    if (lessons) bits.push(`lessons: "${clip(lessons, 200)}"`);
    const tradeNotes = (entry.trades ?? [])
      .flatMap(t => [clean(t.pre_trade_notes), clean(t.post_trade_notes)])
      .filter(Boolean);
    if (tradeNotes.length) bits.push(`trade notes: "${clip(tradeNotes.join(' / '), 320)}"`);
    if (bits.length === 0) continue;

    const emotions = (entry.emotions ?? []).map(e => clean(e?.label)).filter(Boolean).slice(0, 4);
    const meta = [
      entry.date,
      `${entry.trades?.length ?? 0} trade${(entry.trades?.length ?? 0) !== 1 ? 's' : ''}`,
      `net ${fmtNet(entryNet(entry))}`,
      emotions.length ? `emotions: ${emotions.join(', ')}` : null,
    ].filter(Boolean).join(' | ');
    rows.push(`[${meta}]\n${bits.join('\n')}`);
  }

  if (rows.length === 0) return null;

  const silentDays = sorted
    .filter(e => (e.trades?.length ?? 0) > 0 && !entryHasWriting(e))
    .slice(0, 8)
    .map(e => `${e.date} (net ${fmtNet(entryNet(e))})`);

  let out = rows.join('\n\n');
  if (silentDays.length) {
    out += `\n\nDays traded with NO journal writing at all: ${silentDays.join(', ')}`;
  }
  return out;
}

/**
 * Rebuild the pre-session/journal context for a trade entirely server-side, so
 * every analysis path gets it — not just clients that assemble it themselves.
 */
export async function buildServerTradeContext(userId: string, tradeDate: string): Promise<ServerTradeContext> {
  const [preSessionRes, storeRes] = await Promise.all([
    supabase.from('pre_sessions').select('data').eq('user_id', userId).eq('id', tradeDate).maybeSingle(),
    supabase.from('user_store').select('flyxa_data').eq('user_id', userId).maybeSingle(),
  ]);

  // ── Pre-session context (mirrors the FlyxaAIAsk client assembly) ──────────
  let sessionContext: SessionContext | null = null;
  const pre = preSessionRes.data?.data as Record<string, unknown> | null | undefined;
  if (pre && typeof pre === 'object') {
    const commitment = (pre.commitment && typeof pre.commitment === 'object' ? pre.commitment : null) as Record<string, unknown> | null;
    const pick = (key: string): unknown => commitment?.[key] ?? pre[key];

    const ctx: SessionContext = {};
    const emotion = pick('emotion');
    if (typeof emotion === 'string' && emotion.trim()) ctx.emotion = emotion;
    const note = pick('note');
    if (typeof note === 'string' && note.trim()) ctx.note = note;
    const bias = pick('bias');
    if (bias && typeof bias === 'object' && !Array.isArray(bias) && Object.keys(bias).length) {
      ctx.bias = bias as Record<string, string>;
    }
    const readiness = pick('readiness');
    if (readiness && typeof readiness === 'object') ctx.readiness = readiness as SessionContext['readiness'];
    const sessionPlan = pick('sessionPlan');
    if (Array.isArray(sessionPlan) && sessionPlan.length) ctx.sessionPlan = sessionPlan as SessionContext['sessionPlan'];
    if (Object.keys(ctx).length) sessionContext = ctx;
  }

  // ── Journal entries from the store blob ───────────────────────────────────
  const state = (storeRes.data?.flyxa_data as { state?: { entries?: unknown[] } } | null | undefined)?.state;
  const entries: StoreEntry[] = Array.isArray(state?.entries)
    ? (state.entries as StoreEntry[]).filter(e => e && typeof e === 'object' && typeof e.date === 'string')
    : [];

  const dayEntry = entries.find(e => e.date === tradeDate);
  const dr = dayEntry?.dailyReflection;
  const legacy = dayEntry?.reflection;
  if (dr || legacy) {
    const dailyReflection = {
      pre: clean(dr?.pre) || clean(legacy?.pre) || undefined,
      post: clean(dr?.post) || clean(legacy?.post) || undefined,
      lessons: clean(dr?.lessons) || clean(legacy?.lessons) || undefined,
      bias: dr?.bias ?? undefined,
      newsRisk: dr?.newsRisk ?? undefined,
      sessionTarget: typeof dr?.sessionTarget === 'number' ? dr.sessionTarget : undefined,
      marketRespectedBias: typeof dr?.marketRespectedBias === 'boolean' ? dr.marketRespectedBias : undefined,
    };
    const hasAny = Object.values(dailyReflection).some(v => v !== undefined);
    if (hasAny) sessionContext = { ...(sessionContext ?? {}), dailyReflection };
  }

  return {
    sessionContext,
    voiceContext: buildVoiceContext(entries, tradeDate),
  };
}
