import type { JournalEntry, RiskRule } from '../store/types.js';
import {
  evaluateEntryRules,
  summarizeRuleEvaluations,
  type RuleAdherenceSummary,
  type RuleEvaluation,
} from './tradingRules.js';

export interface PlanAdherenceDay {
  entryId: string;
  date: string;
  pnl: number;
  checked: number;
  passed: number;
  failed: number;
  pct: number | null;
  evaluations: RuleEvaluation[];
  failedRules: RuleEvaluation[];
}

export interface PlanRuleBreakdown {
  ruleId: string;
  label: string;
  source: 'automatic' | 'manual';
  checked: number;
  passed: number;
  failed: number;
  pct: number | null;
  lossWhenBroken: number;
  pnlWhenBroken: number;
  dates: string[];
  details: string[];
}

export interface PlanAdherenceReport extends RuleAdherenceSummary {
  entriesChecked: number;
  perfectDays: number;
  brokenDays: number;
  pnlWhenPerfect: number;
  pnlWhenBroken: number;
  lossWhenBroken: number;
  daily: PlanAdherenceDay[];
  brokenRules: PlanRuleBreakdown[];
  mostBrokenRule: PlanRuleBreakdown | null;
  mostExpensiveRule: PlanRuleBreakdown | null;
}

export interface PlanAdherenceOptions {
  bounds?: [string, string];
  accountId?: string | null;
}

function tradeNet(trade: JournalEntry['trades'][number]): number {
  return trade.pnl - (trade.commission ?? 0);
}

function entryNet(entry: JournalEntry): number {
  return entry.trades.reduce((sum, trade) => sum + tradeNet(trade), 0);
}

function matchesAccount(entry: JournalEntry, accountId?: string | null): boolean {
  if (!accountId || accountId.toLowerCase().includes('all')) return true;
  const entryIds = [
    entry.account,
    ...((entry as JournalEntry & { accountIds?: string[] }).accountIds ?? []),
  ].filter(Boolean);
  if (entryIds.includes(accountId)) return true;
  return entry.trades.some(trade => {
    const directTradeAccountId = (trade as JournalEntry['trades'][number] & { accountId?: string }).accountId;
    const tradeIds = [
      trade.account,
      ...(trade.accountIds ?? []),
      ...(directTradeAccountId ? [directTradeAccountId] : []),
    ].filter(Boolean);
    return tradeIds.includes(accountId);
  });
}

function filterEntries(entries: JournalEntry[], options: PlanAdherenceOptions = {}): JournalEntry[] {
  return entries.filter(entry => {
    if (options.bounds && (entry.date < options.bounds[0] || entry.date > options.bounds[1])) return false;
    return matchesAccount(entry, options.accountId);
  });
}

function summarizeRuleBreakdown(days: PlanAdherenceDay[]): PlanRuleBreakdown[] {
  const byRule = new Map<string, PlanRuleBreakdown>();

  days.forEach(day => {
    day.evaluations.forEach(item => {
      if (item.state === 'unchecked') return;
      const current = byRule.get(item.ruleId) ?? {
        ruleId: item.ruleId,
        label: item.label,
        source: item.source,
        checked: 0,
        passed: 0,
        failed: 0,
        pct: null,
        lossWhenBroken: 0,
        pnlWhenBroken: 0,
        dates: [],
        details: [],
      };
      current.checked += 1;
      if (item.state === 'ok') current.passed += 1;
      if (item.state === 'fail') {
        current.failed += 1;
        current.pnlWhenBroken += day.pnl;
        current.lossWhenBroken += Math.max(0, -day.pnl);
        if (!current.dates.includes(day.date)) current.dates.push(day.date);
        if (item.detail && current.details.length < 3) current.details.push(item.detail);
      }
      current.pct = current.checked > 0 ? Math.round((current.passed / current.checked) * 100) : null;
      byRule.set(item.ruleId, current);
    });
  });

  return [...byRule.values()]
    .filter(rule => rule.failed > 0)
    .sort((a, b) => b.failed - a.failed || b.lossWhenBroken - a.lossWhenBroken);
}

export function buildPlanAdherenceReport(
  entries: JournalEntry[],
  rules: RiskRule[],
  options: PlanAdherenceOptions = {},
): PlanAdherenceReport {
  const daily = filterEntries(entries, options).map(entry => {
    const evaluations = evaluateEntryRules(entry, rules);
    const summary = summarizeRuleEvaluations(evaluations);
    const failedRules = evaluations.filter(item => item.state === 'fail');
    return {
      entryId: entry.id,
      date: entry.date,
      pnl: entryNet(entry),
      checked: summary.checked,
      passed: summary.passed,
      failed: summary.failed,
      pct: summary.pct,
      evaluations,
      failedRules,
    };
  });

  const allEvaluations = daily.flatMap(day => day.evaluations);
  const summary = summarizeRuleEvaluations(allEvaluations);
  const checkedDays = daily.filter(day => day.checked > 0);
  const perfectDays = checkedDays.filter(day => day.failed === 0).length;
  const brokenDays = checkedDays.filter(day => day.failed > 0).length;
  const pnlWhenPerfect = checkedDays.filter(day => day.failed === 0).reduce((sum, day) => sum + day.pnl, 0);
  const pnlWhenBroken = checkedDays.filter(day => day.failed > 0).reduce((sum, day) => sum + day.pnl, 0);
  const lossWhenBroken = checkedDays.filter(day => day.failed > 0).reduce((sum, day) => sum + Math.max(0, -day.pnl), 0);
  const brokenRules = summarizeRuleBreakdown(checkedDays);

  return {
    ...summary,
    entriesChecked: checkedDays.length,
    perfectDays,
    brokenDays,
    pnlWhenPerfect,
    pnlWhenBroken,
    lossWhenBroken,
    daily,
    brokenRules,
    mostBrokenRule: brokenRules[0] ?? null,
    mostExpensiveRule: brokenRules.length
      ? [...brokenRules].sort((a, b) => b.lossWhenBroken - a.lossWhenBroken || b.failed - a.failed)[0]
      : null,
  };
}

