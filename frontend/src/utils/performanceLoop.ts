import type { Trade as ApiTrade } from '../types/index.js';
import type {
  PerformanceOutcome,
  PerformancePrescription,
  PerformanceViolation,
  PreSessionData,
} from '../store/types.js';

export interface PerformanceLimits {
  dailyLossLimit: number;
  maxTrades: number;
  maxContracts: number;
}

export function limitsFromPreSession(
  preSession: PreSessionData | null | undefined,
  fallback: Partial<PerformanceLimits> = {},
): PerformanceLimits {
  const prescriptions = preSession?.prescriptions ?? [];
  const valueFor = (type: PerformancePrescription['type']) => {
    const value = prescriptions.find(rule => rule.type === type)?.value;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    dailyLossLimit: Number(preSession?.sessionMaxLoss ?? valueFor('daily_loss_limit') ?? fallback.dailyLossLimit ?? 0) || fallback.dailyLossLimit || 0,
    maxTrades: valueFor('max_trades') || fallback.maxTrades || 0,
    maxContracts: valueFor('max_contracts') || fallback.maxContracts || 0,
  };
}

function netPnl(trade: Pick<ApiTrade, 'pnl' | 'commission'>): number {
  return Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);
}

function isLoss(trade: ApiTrade): boolean {
  return netPnl(trade) < 0;
}

function isRevengeState(value: unknown): boolean {
  return typeof value === 'string' && /revenge|tilt|frustrat|angry|fomo/i.test(value);
}

function violation(
  type: PerformanceViolation['type'],
  severity: PerformanceViolation['severity'],
  evidence: string,
  cost: number,
  tradeId?: string,
): PerformanceViolation {
  return {
    id: `${type}-${tradeId ?? 'session'}-${Date.now()}`,
    ruleId: type,
    type,
    severity,
    evidence,
    cost: Math.round(Math.max(0, cost) * 100) / 100,
    tradeId,
    occurredAt: new Date().toISOString(),
  };
}

export function evaluateTradeViolations(
  trade: ApiTrade,
  earlierDayTrades: ApiTrade[],
  limits: PerformanceLimits,
  preSession?: PreSessionData | null,
): PerformanceViolation[] {
  const violations: PerformanceViolation[] = [];
  const tradeNet = netPnl(trade);
  const priorNet = earlierDayTrades.reduce((sum, item) => sum + netPnl(item), 0);
  const projectedNet = priorNet + tradeNet;

  if (limits.dailyLossLimit > 0 && projectedNet <= -limits.dailyLossLimit) {
    violations.push(violation(
      'daily_loss_limit',
      'critical',
      `Daily P&L reached ${projectedNet.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} against a -$${limits.dailyLossLimit.toLocaleString()} limit.`,
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  if (limits.maxTrades > 0 && earlierDayTrades.length + 1 > limits.maxTrades) {
    violations.push(violation(
      'max_trades',
      'critical',
      `Trade ${earlierDayTrades.length + 1} exceeded the ${limits.maxTrades}-trade session cap.`,
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  if (limits.maxContracts > 0 && Number(trade.contract_size ?? 0) > limits.maxContracts) {
    violations.push(violation(
      'max_contracts',
      'critical',
      `${trade.contract_size} contracts exceeded the ${limits.maxContracts}-contract limit.`,
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  const previousTrade = earlierDayTrades[earlierDayTrades.length - 1];
  if (previousTrade && isLoss(previousTrade) && isRevengeState(trade.emotional_state)) {
    violations.push(violation(
      'revenge_trade',
      'critical',
      `Trade followed a loss while the emotional state was "${trade.emotional_state}".`,
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  const flags = trade.behavioral_flags ?? [];
  if (trade.followed_plan === false || flags.includes('plan-deviation')) {
    violations.push(violation(
      'plan_deviation',
      'warning',
      'The trade was recorded as outside the written plan.',
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  const structured = preSession?.prescriptions ?? [];
  const requiresPause = structured.some(rule => rule.type === 'post_loss_pause' && rule.value === true);
  if (requiresPause && previousTrade && isLoss(previousTrade) && !violations.some(item => item.type === 'revenge_trade')) {
    violations.push(violation(
      'post_loss_pause',
      'warning',
      'The active session plan required a reset after the previous loss.',
      Math.abs(Math.min(0, tradeNet)),
      trade.id,
    ));
  }

  return violations;
}

export function violationBehaviorFlags(violations: PerformanceViolation[]): string[] {
  const map: Partial<Record<PerformanceViolation['type'], string>> = {
    daily_loss_limit: 'past-limit',
    max_trades: 'past-limit',
    max_contracts: 'sized-up',
    revenge_trade: 'revenge',
    plan_deviation: 'plan-deviation',
    post_loss_pause: 'revenge',
  };
  return [...new Set(violations.map(item => map[item.type]).filter((item): item is string => Boolean(item)))];
}

export function generateNextSessionPrescriptions(
  trades: ApiTrade[],
  limits: PerformanceLimits,
): PerformancePrescription[] {
  const recent = [...trades]
    .sort((a, b) => `${a.trade_date} ${a.trade_time}`.localeCompare(`${b.trade_date} ${b.trade_time}`))
    .slice(-30);
  const now = new Date().toISOString();
  const prescriptions: PerformancePrescription[] = [];
  const offPlan = recent.filter(trade => trade.followed_plan === false || (trade.behavioral_flags ?? []).includes('plan-deviation'));
  const oversized = recent.filter(trade => limits.maxContracts > 0 && trade.contract_size > limits.maxContracts);

  let postLossCount = 0;
  let postLossPnl = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (!isLoss(recent[index - 1])) continue;
    postLossCount += 1;
    postLossPnl += netPnl(recent[index]);
  }

  if (postLossCount >= 2 && postLossPnl < 0) {
    prescriptions.push({
      id: 'prescription-post-loss-pause',
      type: 'post_loss_pause',
      value: true,
      label: 'Pause after every loss',
      reason: `Trades immediately after losses produced -$${Math.abs(Math.round(postLossPnl)).toLocaleString()} across ${postLossCount} samples.`,
      sourcePattern: 'negative-post-loss-expectancy',
      createdAt: now,
    });
  }

  if (offPlan.length >= 2) {
    prescriptions.push({
      id: 'prescription-plan-only',
      type: 'plan_only',
      value: true,
      label: 'Only take written-plan setups',
      reason: `${offPlan.length} of the last ${recent.length} trades were marked off-plan.`,
      sourcePattern: 'repeated-plan-deviation',
      createdAt: now,
    });
  }

  if (oversized.length > 0) {
    prescriptions.push({
      id: 'prescription-max-contracts',
      type: 'max_contracts',
      value: limits.maxContracts,
      label: `Maximum ${limits.maxContracts} contracts`,
      reason: `${oversized.length} recent trade${oversized.length === 1 ? '' : 's'} exceeded the configured size limit.`,
      sourcePattern: 'oversizing',
      createdAt: now,
    });
  }

  prescriptions.push({
    id: 'prescription-hard-stop',
    type: 'max_trades',
    value: limits.maxTrades,
    label: `Stop after ${limits.maxTrades} trades`,
    reason: 'This is the configured session trade cap.',
    sourcePattern: 'risk-settings',
    createdAt: now,
  });

  if (limits.dailyLossLimit > 0) {
    prescriptions.push({
      id: 'prescription-daily-loss',
      type: 'daily_loss_limit',
      value: limits.dailyLossLimit,
      label: `Stop at -$${limits.dailyLossLimit.toLocaleString()}`,
      reason: 'This is the configured daily loss limit.',
      sourcePattern: 'risk-settings',
      createdAt: now,
    });
  }

  return prescriptions.slice(0, 3);
}

export function summarizePerformanceOutcome(
  trades: ApiTrade[],
  prescriptions: PerformancePrescription[],
  limits: PerformanceLimits,
  preSession?: PreSessionData | null,
): PerformanceOutcome {
  const sorted = [...trades].sort((a, b) => `${a.trade_date} ${a.trade_time}`.localeCompare(`${b.trade_date} ${b.trade_time}`));
  const violations = sorted.flatMap((trade, index) => evaluateTradeViolations(trade, sorted.slice(0, index), limits, preSession));
  const violatedRuleIds = new Set(violations.map(item => item.ruleId));
  const rulesFollowed = prescriptions.filter(rule => !violatedRuleIds.has(rule.type)).length;
  return {
    evaluatedAt: new Date().toISOString(),
    rulesFollowed,
    totalRules: prescriptions.length,
    adherencePct: prescriptions.length ? Math.round((rulesFollowed / prescriptions.length) * 100) : 100,
    violations,
    estimatedCost: Math.round(violations.reduce((sum, item) => sum + item.cost, 0) * 100) / 100,
    netPnl: Math.round(trades.reduce((sum, trade) => sum + netPnl(trade), 0) * 100) / 100,
  };
}
