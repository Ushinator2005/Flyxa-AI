import type { JournalEntry, RiskRule, RuleState, Trade } from '../store/types.js';

export interface RuleEvaluation {
  ruleId: string;
  label: string;
  state: RuleState;
  source: 'automatic' | 'manual';
  detail: string;
}

export const DEFAULT_STRUCTURED_RULES: RiskRule[] = [
  { id: 'structured-max-daily-loss', label: 'Maximum daily loss', value: '500', unit: '$', color: 'red', kind: 'max_daily_loss', enabled: true },
  { id: 'structured-max-trades', label: 'Maximum trades per day', value: '3', unit: 'trades', color: 'amber', kind: 'max_trades', enabled: true },
  { id: 'structured-max-contracts', label: 'Maximum contracts per trade', value: '2', unit: 'contracts', color: 'amber', kind: 'max_contracts', enabled: true },
  { id: 'structured-min-rr', label: 'Minimum planned R:R', value: '1.5', unit: 'R', color: 'green', kind: 'min_rr', enabled: true },
  { id: 'structured-trading-window', label: 'Allowed trading window', value: '', unit: '', color: 'cobalt', kind: 'time_window', enabled: false, startTime: '09:30', endTime: '11:30' },
  { id: 'structured-cooldown-after-loss', label: 'Cooldown after a loss', value: '20', unit: 'minutes', color: 'amber', kind: 'cooldown_after_loss', enabled: false },
  { id: 'structured-valid-setup', label: 'Trade matched my defined setup', value: '', unit: '', color: 'neutral', kind: 'manual', enabled: true },
];

export function normalizeRiskRule(rule: RiskRule): RiskRule {
  return {
    ...rule,
    kind: rule.kind ?? 'manual',
    enabled: rule.enabled !== false,
    color: rule.color ?? 'neutral',
  };
}

export function automaticRules(rules: RiskRule[]): RiskRule[] {
  return rules.map(normalizeRiskRule).filter(rule => rule.enabled && rule.kind !== 'manual');
}

export function manualRules(rules: RiskRule[]): RiskRule[] {
  return rules.map(normalizeRiskRule).filter(rule => rule.enabled && rule.kind === 'manual');
}

function numericValue(rule: RiskRule): number | null {
  const value = Number(rule.value);
  return Number.isFinite(value) ? value : null;
}

function minutes(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [hours, mins] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
  return hours * 60 + mins;
}

function tradeNet(trade: Trade): number {
  return trade.pnl - (trade.commission ?? 0);
}

export function evaluateTradeRules(
  trade: Trade,
  dayTrades: Trade[],
  rules: RiskRule[]
): RuleEvaluation[] {
  const ordered = [...dayTrades].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const tradeIndex = Math.max(0, ordered.findIndex(item => item.id === trade.id));
  const tradesThroughCurrent = ordered.slice(0, tradeIndex + 1);
  const previousTrade = tradeIndex > 0 ? ordered[tradeIndex - 1] : null;

  return automaticRules(rules).map(rule => {
    const value = numericValue(rule);
    if (rule.kind === 'max_daily_loss') {
      if (value === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Set a valid dollar limit.' };
      const cumulative = tradesThroughCurrent.reduce((sum, item) => sum + tradeNet(item), 0);
      const passed = cumulative > -Math.abs(value);
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `${cumulative.toFixed(2)} net after this trade; limit -${Math.abs(value).toFixed(2)}.` };
    }
    if (rule.kind === 'max_trades') {
      if (value === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Set a valid trade limit.' };
      const passed = tradeIndex + 1 <= value;
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `Trade ${tradeIndex + 1} of ${Math.round(value)} allowed.` };
    }
    if (rule.kind === 'max_contracts') {
      const limits = rule.contractLimits;
      if (limits && Object.keys(limits).length > 0) {
        const sym = trade.symbol.toUpperCase();
        const symbolLimit = limits[sym] ?? limits[trade.symbol];
        if (symbolLimit === undefined) return { ruleId: rule.id, label: rule.label, state: 'ok', source: 'automatic', detail: `No limit set for ${trade.symbol}.` };
        const passed = trade.contracts <= symbolLimit;
        return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `${trade.contracts} contracts in ${trade.symbol}; maximum ${symbolLimit}.` };
      }
      if (value === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Set a valid contract limit.' };
      const passed = trade.contracts <= value;
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `${trade.contracts} contracts; maximum ${value}.` };
    }
    if (rule.kind === 'min_rr') {
      if (value === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Set a valid minimum R:R.' };
      const passed = trade.rr >= value;
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `${trade.rr.toFixed(2)}R planned; minimum ${value.toFixed(2)}R.` };
    }
    if (rule.kind === 'time_window') {
      const entry = minutes(trade.time);
      const start = minutes(rule.startTime);
      const end = minutes(rule.endTime);
      if (entry === null || start === null || end === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Entry time or allowed window is missing.' };
      const passed = start <= end ? entry >= start && entry <= end : entry >= start || entry <= end;
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `Entered ${trade.time}; allowed ${rule.startTime}–${rule.endTime}.` };
    }
    if (rule.kind === 'cooldown_after_loss') {
      if (!previousTrade || tradeNet(previousTrade) >= 0) return { ruleId: rule.id, label: rule.label, state: 'ok', source: 'automatic', detail: 'No preceding losing trade required a cooldown.' };
      if (value === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Set a valid cooldown duration.' };
      const previousExit = minutes(previousTrade.exitTime ?? previousTrade.time);
      const currentEntry = minutes(trade.time);
      if (previousExit === null || currentEntry === null) return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'Trade times are incomplete.' };
      const gap = Math.max(0, currentEntry - previousExit);
      const passed = gap >= value;
      return { ruleId: rule.id, label: rule.label, state: passed ? 'ok' : 'fail', source: 'automatic', detail: `${gap} minute gap after the prior loss; minimum ${value}.` };
    }
    return { ruleId: rule.id, label: rule.label, state: 'unchecked', source: 'automatic', detail: 'This rule requires manual review.' };
  });
}

export function evaluateEntryRules(entry: JournalEntry, rules: RiskRule[]): RuleEvaluation[] {
  const automatic = entry.trades.flatMap(trade => evaluateTradeRules(trade, entry.trades, rules));
  const automaticByRule = automaticRules(rules).map(rule => {
    const checks = automatic.filter(check => check.ruleId === rule.id);
    const failed = checks.find(check => check.state === 'fail');
    const verified = checks.filter(check => check.state !== 'unchecked');
    return failed ?? (verified.length > 0
      ? { ...verified[verified.length - 1], detail: `${verified.length} trade${verified.length === 1 ? '' : 's'} verified.` }
      : { ruleId: rule.id, label: rule.label, state: 'unchecked' as RuleState, source: 'automatic' as const, detail: 'No verifiable trade data.' });
  });
  const manual = manualRules(rules).map(rule => {
    const saved = entry.rules.find(item => item.text === rule.label);
    return {
      ruleId: rule.id,
      label: rule.label,
      state: saved?.state ?? 'unchecked',
      source: 'manual' as const,
      detail: saved?.state === 'ok' ? 'Trader confirmed this rule was followed.' : saved?.state === 'fail' ? 'Trader reported a rule break.' : 'Manual confirmation required.',
    };
  });
  return [...automaticByRule, ...manual];
}
