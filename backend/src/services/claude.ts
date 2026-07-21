import Anthropic from '@anthropic-ai/sdk';
import { Trade } from '../types/index';
import dotenv from 'dotenv';
import sharp from 'sharp';
import { normalizeConfluenceKey, normalizeConfluences } from '../utils/confluenceTags';

dotenv.config({ override: true });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-5';
const MODEL_TEMPERATURE = 0;

export async function analyzeIndividualTrade(
  trade: Trade,
  statsContext: string | null = null,
  voiceContext: string | null = null
): Promise<string> {
  const rr = trade.sl_price && trade.entry_price && trade.tp_price
    ? Math.abs(trade.tp_price - trade.entry_price) / Math.abs(trade.sl_price - trade.entry_price)
    : 0;

  const sessionContext = trade.sessionContext;
  const sessionContextLines: string[] = [];
  if (sessionContext) {
    if (sessionContext.emotion) sessionContextLines.push(`Pre-session state of mind: ${sessionContext.emotion}`);
    if (sessionContext.readiness) {
      const readinessParts = [
        sessionContext.readiness.status,
        typeof sessionContext.readiness.score === 'number' ? `${sessionContext.readiness.score}/100` : null,
        sessionContext.readiness.summary,
      ].filter(Boolean);
      if (readinessParts.length) sessionContextLines.push(`Readiness: ${readinessParts.join(' | ')}`);
      if (Array.isArray(sessionContext.readiness.reasons) && sessionContext.readiness.reasons.length) {
        sessionContextLines.push(`Readiness reasons: ${sessionContext.readiness.reasons.join(' | ')}`);
      }
    }
    if (sessionContext.bias && typeof sessionContext.bias === 'object') {
      const biasPairs = Object.entries(sessionContext.bias)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([symbol, value]) => `${symbol}: ${value}`);
      if (biasPairs.length) sessionContextLines.push(`Pre-session market bias: ${biasPairs.join(' | ')}`);
    }
    if (sessionContext.note) sessionContextLines.push(`Pre-session note: ${sessionContext.note}`);
    if (Array.isArray(sessionContext.sessionPlan) && sessionContext.sessionPlan.length) {
      const planLines = sessionContext.sessionPlan
        .map(item => item?.rule)
        .filter((rule): rule is string => typeof rule === 'string' && rule.trim().length > 0);
      if (planLines.length) sessionContextLines.push(`Pre-session plan: ${planLines.join(' | ')}`);
    }
    const daily = sessionContext.dailyReflection;
    if (daily) {
      if (daily.pre) sessionContextLines.push(`Daily pre-market plan: ${daily.pre}`);
      if (daily.post) sessionContextLines.push(`Post-session reflection: ${daily.post}`);
      if (daily.lessons) sessionContextLines.push(`Lessons noted that day: ${daily.lessons}`);
      const dailyParts = [
        daily.bias ? `daily bias ${daily.bias}` : null,
        daily.newsRisk ? `news risk ${daily.newsRisk}` : null,
        typeof daily.sessionTarget === 'number' ? `session target ${daily.sessionTarget}` : null,
        typeof daily.marketRespectedBias === 'boolean' ? `market respected bias ${daily.marketRespectedBias ? 'yes' : 'no'}` : null,
      ].filter(Boolean);
      if (dailyParts.length) sessionContextLines.push(`Daily context: ${dailyParts.join(' | ')}`);
    }
  }
  const sessionContextBlock = sessionContextLines.length
    ? `\n\n## Pre-session Context\n${sessionContextLines.join('\n')}`
    : '';

  const contextBlock = statsContext
    ? `\n\n## Trader's Historical Data (use ONLY these numbers — do not invent or estimate any figures not present here)\n${statsContext}`
    : `\n\n## Trader's Historical Data\nNo historical stats available. Do not output N/A rows; say there is not enough logged history yet only if a comparison is unavailable.`;

  const voiceBlock = voiceContext
    ? `\n\n## Trader's Recent Journal Writing (verbatim, newest first — analyse HOW they write, not just what)\n${voiceContext}`
    : '';

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 900,
    system: `You are a professional trading performance analyst reviewing a trader's logged trade. You have their full historical statistics. Your job is to produce a genuine analysis — not a summary of what happened, but an examination of why it happened, what pattern it represents across their history, and what it reveals about their edge and its breakdown points.

An analysis reasons across the data. It finds the causal chain: what led to this decision, how it connects to prior behaviour, what the stats prove about where the edge exists and where it doesn't.

CRITICAL: Every dollar amount, win rate, P&L figure, and trade count you cite MUST come verbatim from the "Trader's Historical Data" section provided. Never invent, estimate, or extrapolate any numerical figure. If a comparison is unavailable, skip it or say there is not enough logged history yet. Do not output filler N/A rows.

Use the pre-session context when it is provided. Judge whether this trade aligned with the trader's stated state of mind, readiness, session plan, and market bias. Treat pre-session bias as context, not a guarantee: a counter-bias trade can still be valid if the notes explain the shift.

When the trader's recent journal writing is provided, read it the way a performance psychologist listens to a voice recording — HOW they write is data, not just what they write:
- Establish their baseline voice from the samples: typical entry length, structure, punctuation habits, and how they normally talk about losses.
- Flag deviations from that baseline on or around this trade's date: entries going terse or vanishing after red days; exclamation marks, ALL CAPS, or profanity appearing in a normally measured writer; revenge phrasing ("get it back", "make it back", "one more"); certainty inflation ("free money", "guaranteed", "easy", "can't lose"); blaming the market, algos, or news instead of their own process; bargaining language ("just this once"); or a clean writer suddenly going sloppy — dropped punctuation, typos, fragments.
- Silence is a signal: a day with trades but no writing — especially after losses — usually marks avoidance or tilt. The context lists these days explicitly.
- When you make a tone-based read, QUOTE the exact phrase and its date as evidence. Never claim a tone shift you cannot quote. If the writing shows no deviation, say nothing about tone rather than inventing one.
- Join the linguistic read to the numbers: when the writing shows tilt and the stats show its cost, connect them into one causal line. That connection — "you wrote X on the 14th, and your next three trades gave back $Y" — is the most valuable sentence you can produce.

Do not write generic coaching advice. Do not restate what is already visible in the trade data. Write what the trader cannot see without this analysis. Do not create a new permanent trading rule after every reviewed trade; only recommend a hard rule when repeated historical evidence supports it.`,
    messages: [
      {
        role: 'user',
        content: `Trade to analyse:
${trade.symbol} ${trade.direction} | ${trade.trade_date} ${trade.trade_time || ''}
Entry ${trade.entry_price} → Exit ${trade.exit_price} | SL ${trade.sl_price} | TP ${trade.tp_price}
P&L: $${trade.pnl.toFixed(2)} | Planned R:R: ${rr.toFixed(2)} | Duration: ${trade.trade_length_seconds ? Math.round(trade.trade_length_seconds / 60) + 'min' : 'unknown'}
Emotional state: ${trade.emotional_state} | Confidence: ${trade.confidence_level}/10 | Followed plan: ${trade.followed_plan ? 'Yes' : 'No'}
Confluences: ${Array.isArray(trade.confluences) && trade.confluences.length > 0 ? trade.confluences.join(', ') : 'None tagged'}
Notes: ${[trade.pre_trade_notes, trade.post_trade_notes].filter(Boolean).join(' | ') || 'None'}${sessionContextBlock}${contextBlock}${voiceBlock}

Write a structured analysis using exactly these three sections:

## Your Stats
Anchor the analysis in their data. Write 2-3 bullets maximum. Use only the strongest available stats. Skip weak or unavailable categories. Do not write N/A.

## The Read
**[One sharp verdict sentence — what this trade actually represents, beyond the surface result]**
> [First insight — WHY this decision was made. One sentence, max 18 words. Include a number where possible.]
> [Second insight — what setup quality, pre-session state/bias, and plan adherence together reveal. One sentence. When the journal writing carries a tone signal (tilt, revenge phrasing, certainty inflation, silence after losses), THIS line must be the linguistic read — quote the trader's own words and date.]

## Next Focus
**[The one thing to pay attention to before or during the next similar setup, framed as an execution focus rather than a logging task.]**
FOCUS: [One sentence. Give a practical trading focus such as bias alignment, invalidation clarity, entry timing, risk placement, emotional state, or setup threshold. Do not tell the user to log, record, track, or collect the next N trades.]
IMPORTANT: Do not recommend a new hard rule unless the historical data shows the same leak repeatedly. Most trade reviews should produce a small observation or test, not a restriction.
Final output constraints:
- Section 01 must contain only 2-3 relevant stats. Skip weak or unavailable categories. Do not write N/A.
- Section 02 must contain one verdict sentence and exactly two > insight lines.
- Section 03 must be titled Next Focus and use FOCUS:, not RULE: or ADJUSTMENT:.
- Section 03 must not ask the user to log, record, track, monitor, or collect future trades; every trade is already logged. The focus should change how they prepare, decide, execute, or manage risk.
- Do not output a TAGS line.
- If a matching sample has fewer than 5 trades, call it an early signal or something to track, not proof.
- Do not turn this into a permanent trading-plan rule unless repeated historical evidence clearly supports it.`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function analyzePatterns(trades: Trade[]): Promise<string> {
  const tradeSummaries = trades.map(t => ({
    symbol: t.symbol,
    direction: t.direction,
    date: t.trade_date,
    time: t.trade_time,
    session: t.session,
    pnl: t.pnl,
    exit_reason: t.exit_reason,
    emotional_state: t.emotional_state,
    confidence: t.confidence_level,
    followed_plan: t.followed_plan,
    confluences: Array.isArray(t.confluences) ? t.confluences : [],
    rr: t.sl_price && t.entry_price && t.tp_price
      ? (Math.abs(t.tp_price - t.entry_price) / Math.abs(t.sl_price - t.entry_price)).toFixed(2)
      : 'N/A',
  }));

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a professional trading performance analyst specialising in pattern recognition and behavioral finance.
Analyse trading data to find actionable patterns, both profitable and detrimental.
Be specific with numbers and percentages. Identify root causes of problems.`,
    messages: [
      {
        role: 'user',
        content: `Analyse these ${trades.length} futures trades and identify all significant patterns:

${JSON.stringify(tradeSummaries, null, 2)}

Provide a comprehensive pattern analysis covering:
1. Best performing setups (time, session, symbol, direction)
2. Worst performing patterns and why
3. Emotional state impact on performance
4. Plan adherence correlation with results
5. Risk management patterns
6. Time-of-day and session edge analysis
7. Confidence calibration (do high confidence trades perform better?)
8. Confluence performance (which tagged confluences are most profitable vs most costly)
9. Most critical behavioural improvements needed
10. Top 3 strengths to capitalise on
11. Top 3 weaknesses that are costing the most money`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function generateWeeklyReport(
  trades: Trade[],
  weekStart: string,
  weekEnd: string
): Promise<string> {
  const wins = trades.filter(t => t.exit_reason === 'TP');
  const losses = trades.filter(t => t.exit_reason === 'SL');
  const netPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0';
  const confluenceBuckets = trades.reduce<Record<string, { count: number; pnl: number }>>((acc, trade) => {
    const tags = normalizeConfluences(trade.confluences);
    tags.forEach(tag => {
      const key = normalizeConfluenceKey(tag);
      if (!acc[key]) {
        acc[key] = { count: 0, pnl: 0 };
      }
      acc[key].count += 1;
      acc[key].pnl += trade.pnl;
    });
    return acc;
  }, {});

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a professional trading performance coach generating weekly review reports.
Create comprehensive, structured reports that help traders improve systematically.
Be specific, actionable, and data-driven. Format your response with clear sections using markdown.`,
    messages: [
      {
        role: 'user',
        content: `Generate a comprehensive weekly performance report for the week of ${weekStart} to ${weekEnd}.

Summary Statistics:
- Total Trades: ${trades.length}
- Wins: ${wins.length} | Losses: ${losses.length}
- Win Rate: ${winRate}%
- Net P&L: $${netPnL.toFixed(2)}

Confluence Breakdown:
${JSON.stringify(
  Object.entries(confluenceBuckets)
    .map(([confluence, data]) => ({ confluence, trades: data.count, net_pnl: data.pnl }))
    .sort((a, b) => b.net_pnl - a.net_pnl),
  null,
  2
)}

Individual Trades:
${JSON.stringify(trades.map(t => ({
  date: t.trade_date,
  time: t.trade_time,
  symbol: t.symbol,
  direction: t.direction,
  session: t.session,
  pnl: t.pnl,
  exit_reason: t.exit_reason,
  emotional_state: t.emotional_state,
  confidence: t.confidence_level,
  followed_plan: t.followed_plan,
  confluences: Array.isArray(t.confluences) ? t.confluences : [],
})), null, 2)}

Create a report with these sections:
# Weekly Performance Report: ${weekStart} to ${weekEnd}

## Executive Summary
## Performance Statistics
## Best Trades of the Week
## Worst Trades and Lessons
## Psychological Performance
## Plan Adherence Analysis
## Key Patterns Observed
## Confluence Performance (best vs worst tagged confluences)
## Goals for Next Week
## Action Items (specific, numbered list)`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function generatePsychologyReport(
  trades: Trade[],
  psychLogs: Array<{
    date: string;
    mood: string;
    mindset_score: number;
    pre_session_notes: string;
    post_session_notes: string;
  }>
): Promise<string> {
  const emotionalBreakdown = trades.reduce<Record<string, { count: number; pnl: number }>>((acc, t) => {
    const state = t.emotional_state || 'Unknown';
    if (!acc[state]) acc[state] = { count: 0, pnl: 0 };
    acc[state].count++;
    acc[state].pnl += t.pnl;
    return acc;
  }, {});

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 3000,
    system: `You are a trading psychologist specialising in performance psychology and behavioral finance.
Provide deep, insightful analysis of a trader's psychological patterns.
Be empathetic but brutally honest about destructive patterns.
Give concrete, practical psychological techniques to improve performance.`,
    messages: [
      {
        role: 'user',
        content: `Perform a deep psychology analysis for this futures trader.

Emotional State vs Performance:
${JSON.stringify(emotionalBreakdown, null, 2)}

Plan Adherence: ${trades.filter(t => t.followed_plan).length}/${trades.length} trades followed the plan

Psychology Logs (recent):
${JSON.stringify(psychLogs.slice(-14), null, 2)}

Trades Not Following Plan:
${JSON.stringify(trades.filter(t => !t.followed_plan).map(t => ({
  date: t.trade_date,
  emotional_state: t.emotional_state,
  pnl: t.pnl,
  notes: t.post_trade_notes,
})), null, 2)}

Provide a comprehensive psychology report:
# Trading Psychology Report

## Emotional State Analysis
## Behavioral Patterns
## Tilt and Revenge Trading Assessment
## FOMO and Overconfidence Patterns
## Discipline and Plan Adherence
## Mindset Score Trends
## Root Cause Analysis
## Recommended Psychological Strategies
## Daily Routine Recommendations
## Affirmations and Mental Framework`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function compareTradeToPlaybook(
  trade: Trade,
  playbookEntries: Array<{
    setup_name: string;
    description: string;
    rules: string;
    ideal_conditions: string;
  }>
): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 2048,
    system: `You are a trading coach that specialises in evaluating whether trades adhere to established trading playbooks and rules.
Be specific about which rules were followed and which were violated.
Provide a structured compliance assessment.`,
    messages: [
      {
        role: 'user',
        content: `Evaluate this trade against the trading playbook.

Trade Details:
${JSON.stringify({
  symbol: trade.symbol,
  direction: trade.direction,
  date: trade.trade_date,
  time: trade.trade_time,
  session: trade.session,
  entry_price: trade.entry_price,
  sl_price: trade.sl_price,
  tp_price: trade.tp_price,
  exit_reason: trade.exit_reason,
  pnl: trade.pnl,
  emotional_state: trade.emotional_state,
  confidence_level: trade.confidence_level,
  followed_plan: trade.followed_plan,
  confluences: Array.isArray(trade.confluences) ? trade.confluences : [],
  pre_trade_notes: trade.pre_trade_notes,
  post_trade_notes: trade.post_trade_notes,
}, null, 2)}

Playbook Entries:
${JSON.stringify(playbookEntries, null, 2)}

Provide a detailed compliance assessment:
# Playbook Compliance Report

## Best Matching Setup
## Rules Followed
## Rules Violated
## Ideal Conditions Match
## Compliance Score (0-100%)
## Specific Violations and Impact
## How to Better Execute This Setup Next Time`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }
  return content.text;
}

export async function answerFlyxaQuestion(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }> = []
): Promise<string> {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    throw new Error('Question is required');
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: MODEL_TEMPERATURE,
    max_tokens: 700,
    system: `You are Flyxa's built-in product assistant.

Flyxa is a futures trading journal and review workspace. Key areas include:
- Trade journaling and daily reflections
- Dashboard analytics and performance review
- AI Coach analysis
- Risk Manager and daily risk controls
- Trade Scanner and chart import workflows
- Backtesting / replay
- Playbook and psychology tracking

Rules:
- Answer questions about Flyxa clearly and helpfully.
- Be concise, practical, and product-focused.
- If the user asks how to do something in Flyxa, give direct steps.
- If the user asks about account-specific data, explain you cannot see their private data from the chat widget.
- If the question is unrelated to Flyxa, gently steer back to Flyxa and what the product does.
- Do not invent features that Flyxa does not clearly have.
- Keep responses in plain text, usually 2-6 short sentences.`,
    messages: [
      ...history
        .filter(message => message.content.trim() !== '')
        .slice(-8)
        .map(message => ({
          role: message.role,
          content: message.content,
        })),
      {
        role: 'user',
        content: trimmedQuestion,
      },
    ],
  });

  const textBlocks = response.content.filter(block => block.type === 'text');
  const combined = textBlocks.map(block => block.text.trim()).filter(Boolean).join('\n\n');

  if (!combined) {
    throw new Error('Unexpected response type from Claude');
  }

  return combined;
}

// ── Ask Flyxa — data-grounded trade query ─────────────────────────────────────

export async function answerTradeDataQuery(
  question: string,
  stats: Record<string, unknown>
): Promise<string> {
  const trimmed = question.trim();
  if (!trimmed) throw new Error('Question is required');

  const normalizedQuestion = trimmed.toLowerCase();
  const asksTopstepRules = normalizedQuestion.includes('topstep')
    && /(rule|rules|target|drawdown|loss limit|contract|pass|activation)/.test(normalizedQuestion);
  if (asksTopstepRules) {
    const available = Array.isArray(stats.availableTopstepRules)
      ? stats.availableTopstepRules as Array<Record<string, unknown>>
      : [];
    const activeRule = stats.activePropFirmRule && typeof stats.activePropFirmRule === 'object'
      ? stats.activePropFirmRule as Record<string, unknown>
      : null;
    const size = normalizedQuestion.includes('150k') || normalizedQuestion.includes('150,000')
      ? 150_000
      : normalizedQuestion.includes('100k') || normalizedQuestion.includes('100,000')
        ? 100_000
        : normalizedQuestion.includes('50k') || normalizedQuestion.includes('50,000')
          ? 50_000
          : Number(activeRule?.accountSize ?? 0);
    const requestedPath = /no activation|no-activation|activation fee path/.test(normalizedQuestion)
      ? 'no_activation_fee'
      : normalizedQuestion.includes('standard')
        ? 'standard'
        : String(activeRule?.path ?? '');
    const matching = available.find(rule => (
      Number(rule.accountSize) === size
      && (!requestedPath || rule.path === requestedPath)
    )) ?? available.find(rule => Number(rule.accountSize) === size) ?? activeRule;

    if (matching) {
      const usd = (value: unknown) => Number(value ?? 0).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      });
      const path = matching.path === 'no_activation_fee' ? 'No Activation Fee' : 'Standard';
      const dailyLoss = Number(matching.dailyLossLimit ?? 0) > 0
        ? `${usd(matching.dailyLossLimit)} fixed daily loss limit`
        : `no mandatory daily loss limit; Topstep offers an optional ${usd(matching.optionalDailyLossLimit)} fixed limit at purchase`;
      return `A Topstep ${Number(matching.accountSize) / 1000}K Trading Combine on the ${path} path requires ${usd(matching.profitTarget)} in profit, has a ${usd(matching.maxDrawdown)} real-time trailing Maximum Loss Limit, and allows up to ${matching.maxContracts} mini contracts or ${matching.maxMicros} micros. It uses a ${matching.consistencyLimitPct}% consistency objective and can be passed in a minimum of ${matching.minimumTradingDays} trading days. This configuration has ${dailyLoss}; the activation fee is ${usd(matching.activationFee)}. Flyxa has this as verified rule version ${matching.version ?? 1}, last checked ${String(matching.verifiedAt ?? 'from the bundled catalog')}, but you should still compare it with your Topstep dashboard because account terms can change.`;
    }
  }

  const statsJson = JSON.stringify(stats, null, 2);

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 700,
    system: `You are Flyxa AI — a sharp, brutally honest trading performance analyst embedded inside a trade journal app.

The user just asked you a question about their trading. You have been given their complete computed trading statistics below. Your job is to:
1. Understand exactly what the user is asking (even if phrased casually or ambiguously).
2. Locate the relevant numbers from the provided stats.
3. Give a direct, precise, data-driven answer using their actual figures — never invent numbers.
4. Proactively surface any important pattern you notice (good or bad) that's relevant to their question.
5. End with one specific, actionable recommendation.
6. Prop-firm rules may be present under activePropFirmRule and availableTopstepRules. Use them directly and never claim rule information is unavailable when those fields contain a matching rule.
7. Never invent a prop-firm rule. If no matching structured rule exists, say it is not in Flyxa's verified catalog.

Style rules:
- Plain conversational English. No bullet lists. No markdown headers.
- 3–5 sentences. Concise and meaty — no filler phrases.
- Lead with the answer, not with preamble like "Based on your data..." or "Great question!".
- Use specific percentages and dollar amounts from the provided stats.
- If a specific breakdown has fewer than 5 samples, note the small sample size and caveat accordingly.
- If the stats don't contain enough information to answer the question, say so plainly and suggest what data the user should log.

TRADE STATISTICS (JSON):
${statsJson}`,
    messages: [{ role: 'user', content: trimmed }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text.trim())
    .filter(Boolean)
    .join('\n\n');

  if (!text) throw new Error('No response from Claude');
  return text;
}

// ── Market news AI filter ─────────────────────────────────────────────────────

export interface NewsFilterItem {
  headline: string;
  summary: string;
  impact: 'high' | 'medium' | 'low';
  category: string;
  marketImpact: { es: string; nq: string; note?: string };
  isBreaking: boolean;
  source: string;
  timestamp: string;
  url?: string;
}

export async function filterNewsItems(
  headlines: Array<{ headline: string; source: string; timestamp: string; summary?: string; url?: string }>
): Promise<NewsFilterItem[]> {
  if (headlines.length === 0) return [];

  const system = `You are a market news filter for a futures trader who trades ES and NQ.
Your job is to filter a list of news headlines and return ONLY items that are likely to move US equity index futures (ES, NQ, YM) today.

For each relevant item return:
{
  "headline": string (keep original or slightly cleaned),
  "summary": string (1-2 sentences, plain English, explain WHY it matters for futures traders specifically),
  "impact": "high" | "medium" | "low",
  "category": "Fed" | "Earnings" | "Geopolitical" | "Macro" | "Energy" | "Political" | "Crypto" | "Other",
  "marketImpact": {
    "es": "very bullish" | "bullish" | "slightly bullish" | "neutral" | "slightly bearish" | "bearish" | "very bearish",
    "nq": "very bullish" | "bullish" | "slightly bullish" | "neutral" | "slightly bearish" | "bearish" | "very bearish",
    "note": string (optional, e.g. "wait for reaction")
  },
  "isBreaking": boolean,
  "source": string,
  "timestamp": string
}

Rules:
- Return max 10 items total
- If nothing is relevant return []
- Assign "high" only for Fed decisions, major geopolitical events, top-10 S&P500 earnings misses/beats, systemic risk events
- Assign "medium" for economic data releases, sector earnings, political policy announcements
- Assign "low" for background context items
- isBreaking = true only if timestamp is within 30 minutes of now AND impact is high
- Do NOT include crypto news unless it has clear equity market implications
- Respond with ONLY valid JSON array, no markdown, no code fences`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1800,
    system,
    messages: [{
      role: 'user',
      content: JSON.stringify(headlines.map(h => ({
        headline: h.headline,
        source: h.source,
        timestamp: h.timestamp,
        summary: h.summary?.substring(0, 200),
      }))),
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
  const clean = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NewsFilterItem =>
      typeof item === 'object' && item !== null &&
      typeof item.headline === 'string' &&
      typeof item.summary === 'string' &&
      ['high', 'medium', 'low'].includes(item.impact)
    ).map(item => ({
      ...item,
      url: headlines.find(h => h.headline.slice(0, 30) === item.headline.slice(0, 30))?.url,
    }));
  } catch {
    return [];
  }
}

export interface JournalInsightPattern {
  id: string;
  type: 'Risk' | 'Edge' | 'Psychology' | 'Behaviour';
  status: 'Active' | 'Improving' | 'Confirmed' | 'Resolved';
  title: string;
  description: string;
  confidence: number;
  tradeDates: string[];
  tags: Array<{ label: string; sentiment: 'positive' | 'negative' | 'neutral' }>;
  instrument: string;
  session: 'RTH open' | 'Overlap' | 'Midday';
}

export async function analyzeJournalInsights(
  entries: Array<{
    date: string;
    trades: Array<{
      symbol: string;
      direction: string;
      result: string;
      pnl: number;
      rr: number;
      entryTime?: string;
      followedPlan?: boolean | null;
      processGrade?: number;
      thesis?: string;
      execution?: string;
      adjustment?: string;
    }>;
    pre?: string;
    post?: string;
    lessons?: string;
  }>
): Promise<JournalInsightPattern[]> {
  const totalTrades = entries.reduce((n, e) => n + e.trades.length, 0);
  if (totalTrades === 0) return [];

  const digest = entries.map(e => ({
    date: e.date,
    pre: e.pre?.trim() || null,
    post: e.post?.trim() || null,
    lessons: e.lessons?.trim() || null,
    trades: e.trades.map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      result: t.result,
      pnl: t.pnl,
      rr: Number(t.rr?.toFixed(2)),
      entryTime: t.entryTime,
      followedPlan: t.followedPlan,
      processGrade: t.processGrade,
      thesis: t.thesis?.trim() || null,
      execution: t.execution?.trim() || null,
      adjustment: t.adjustment?.trim() || null,
    })),
  }));

  const prompt = `You are a professional trading coach analysing a trader's complete journal.

Analyse these ${totalTrades} trades across ${entries.length} trading days and identify 4–8 real behavioural and performance patterns.
Focus heavily on the written reflections (thesis, execution, lessons) — these contain the truth about why trades won or lost.

Journal data:
${JSON.stringify(digest, null, 2)}

Return ONLY a JSON array (no other text, no markdown). Each item must match exactly:
{
  "id": "p1",                          // unique string
  "type": "Risk" | "Edge" | "Psychology" | "Behaviour",
  "status": "Active" | "Improving" | "Confirmed",
  "title": string,                     // max 70 chars, specific
  "description": string,               // 2–3 sentences referencing actual journal text
  "confidence": number,                // 50–99 integer
  "tradeDates": string[],              // dates (YYYY-MM-DD) where this pattern appears
  "tags": [{ "label": string, "sentiment": "positive"|"negative"|"neutral" }],
  "instrument": string,                // e.g. "NQ" or "Mixed"
  "session": "RTH open" | "Overlap" | "Midday"
}

Rules:
- "Edge" type = consistently profitable behaviours to reinforce
- "Risk" type = behaviours costing money
- "Psychology" type = emotional or cognitive patterns
- "Behaviour" type = execution or process patterns
- Only report patterns with at least 2 data points in the journal
- Be specific — reference actual entry times, symbols, written notes where possible
- Return at minimum 2 Edge patterns and 2 Risk/Psychology patterns`;

  const response = await anthropic.messages.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.content[0];
  if (content.type !== 'text') return [];

  try {
    const raw = content.text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw) as JournalInsightPattern[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      p => p.id && p.type && p.title && p.description && Array.isArray(p.tradeDates)
    );
  } catch {
    return [];
  }
}
