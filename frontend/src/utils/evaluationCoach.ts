import type { Account, Trade } from '../store/types.js';

// How the maximum-loss-limit (MLL) floor moves:
//   static             — fixed at startingBalance − maxDrawdown, never moves.
//   eod_trailing       — ratchets up from end-of-day balance highs only; today's
//                        running balance never raises it until the day settles.
//   intraday_trailing  — ratchets up from every new equity high. Flyxa only sees
//                        closed-trade equity, so firms that trail on unrealized
//                        open-trade peaks (e.g. Apex) may sit slightly higher.
//   trailing           — legacy value from older saved accounts; treated as
//                        intraday_trailing (the previous behavior).
export type DrawdownType = 'static' | 'trailing' | 'eod_trailing' | 'intraday_trailing';

export interface EvaluationTemplate {
  id: string;
  firm: string;
  label: string;
  accountSize: number;
  profitTarget: number;
  dailyLossLimit: number;
  maxDrawdown: number;
  minimumTradingDays: number;
  maxContracts: number;
  consistencyLimitPct: number | null;
  drawdownType: DrawdownType;
  // Balance level where the MLL locks and stops trailing (null = trails forever).
  trailingStopsAt?: number | null;
  note: string;
  program?: string;
  path?: 'standard' | 'no_activation_fee' | 'custom';
  activationFee?: number;
  monthlyPrice?: number;
  optionalDailyLossLimit?: number | null;
  responsibleTradingDiscount?: number;
  responsibleTradingBenefit?: string;
  maxMicros?: number;
  version?: number;
  status?: 'verified' | 'draft' | 'retired';
  verifiedAt?: string;
  effectiveFrom?: string;
  sourceUrl?: string;
  secondarySourceUrls?: string[];
}

export interface EvaluationProgress {
  accountId: string;
  netPnl: number;
  currentBalance: number;
  targetRemaining: number;
  targetProgressPct: number;
  dailyPnl: number;
  dailyLossRemaining: number;
  /** The MLL — the balance the account must stay above. */
  drawdownFloor: number;
  drawdownUsed: number;
  drawdownRemaining: number;
  drawdownType: 'static' | 'eod_trailing' | 'intraday_trailing';
  trailingStopsAt: number | null;
  /** True once the MLL has reached trailingStopsAt and no longer moves. */
  floorLocked: boolean;
  tradingDays: number;
  minimumTradingDays: number;
  passProbability: number;
  probabilityFactors: {
    targetScore: number;    // 0-100 — profit progress toward target (36% weight)
    survivalScore: number;  // 0-100 — drawdown buffer health (26% weight)
    recentWinRate: number;  // 0-100 — win rate over last 20 trades (12% weight)
    dayQuality: number;     // 0-100 — % of days that were profitable (8% weight)
  };
  status: 'on-track' | 'at-risk' | 'violated' | 'passed';
  warnings: string[];
}

export interface EvaluationAgentAlert {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  action: string;
}

export interface PropFirmRuleRecord {
  id: string;
  firm: string;
  program: string;
  path: 'standard' | 'no_activation_fee';
  accountSize: number;
  profitTarget: number;
  maximumLossLimit: number;
  dailyLossLimit: number | null;
  optionalDailyLossLimit: number | null;
  responsibleTradingDiscount: number;
  responsibleTradingBenefit: string;
  maximumContracts: number;
  maximumMicros: number;
  consistencyTargetPct: number;
  minimumTradingDays: number;
  drawdownType: DrawdownType;
  trailingStopsAt: number | null;
  activationFee: number;
  monthlyPrice: number;
  version: number;
  status: 'verified' | 'draft' | 'retired';
  effectiveFrom: string;
  verifiedAt: string;
  sourceUrl: string;
  secondarySourceUrls: string[];
  note: string;
}

export function ruleRecordToTemplate(rule: PropFirmRuleRecord): EvaluationTemplate {
  const pathLabel = rule.path === 'no_activation_fee' ? 'No activation fee' : 'Standard';
  return {
    id: rule.id,
    firm: rule.firm,
    program: rule.program,
    label: `${rule.firm} ${rule.accountSize / 1000}K · ${pathLabel}`,
    accountSize: rule.accountSize,
    profitTarget: rule.profitTarget,
    dailyLossLimit: rule.dailyLossLimit ?? 0,
    optionalDailyLossLimit: rule.optionalDailyLossLimit,
    responsibleTradingDiscount: rule.responsibleTradingDiscount,
    responsibleTradingBenefit: rule.responsibleTradingBenefit,
    maxDrawdown: rule.maximumLossLimit,
    minimumTradingDays: rule.minimumTradingDays,
    maxContracts: rule.maximumContracts,
    maxMicros: rule.maximumMicros,
    consistencyLimitPct: rule.consistencyTargetPct,
    drawdownType: rule.drawdownType,
    trailingStopsAt: rule.trailingStopsAt,
    path: rule.path,
    activationFee: rule.activationFee,
    monthlyPrice: rule.monthlyPrice,
    version: rule.version,
    status: rule.status,
    effectiveFrom: rule.effectiveFrom,
    verifiedAt: rule.verifiedAt,
    sourceUrl: rule.sourceUrl,
    secondarySourceUrls: rule.secondarySourceUrls,
    note: rule.note,
  };
}

export const TOPSTEP_RULES: PropFirmRuleRecord[] = [
  ...([
    { accountSize: 50_000, profitTarget: 3_000, maximumLossLimit: 2_000, optionalDailyLossLimit: 1_000, responsibleTradingDiscount: 10, maximumContracts: 5, maximumMicros: 50, standardPrice: 49, noActivationPrice: 95 },
    { accountSize: 100_000, profitTarget: 6_000, maximumLossLimit: 3_000, optionalDailyLossLimit: 2_000, responsibleTradingDiscount: 20, maximumContracts: 10, maximumMicros: 100, standardPrice: 99, noActivationPrice: 149 },
    { accountSize: 150_000, profitTarget: 9_000, maximumLossLimit: 4_500, optionalDailyLossLimit: 3_000, responsibleTradingDiscount: 30, maximumContracts: 15, maximumMicros: 150, standardPrice: 199, noActivationPrice: 229 },
  ] as const).flatMap(size => ([
    {
      id: `topstep-trading-combine-${size.accountSize}-standard-v1`,
      firm: 'Topstep',
      program: 'Trading Combine',
      path: 'standard' as const,
      accountSize: size.accountSize,
      profitTarget: size.profitTarget,
      maximumLossLimit: size.maximumLossLimit,
      dailyLossLimit: null,
      optionalDailyLossLimit: size.optionalDailyLossLimit,
      responsibleTradingDiscount: 0,
      responsibleTradingBenefit: '',
      maximumContracts: size.maximumContracts,
      maximumMicros: size.maximumMicros,
      consistencyTargetPct: 50,
      minimumTradingDays: 2,
      drawdownType: 'eod_trailing' as const,
      trailingStopsAt: size.accountSize,
      activationFee: 149,
      monthlyPrice: size.standardPrice,
      version: 1,
      status: 'verified' as const,
      effectiveFrom: '2026-06-18',
      verifiedAt: '2026-06-22T00:00:00Z',
      sourceUrl: 'https://help.topstep.com/en/articles/8284197-trading-combine-parameters',
      secondarySourceUrls: [
        'https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit',
        'https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account',
        'https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions',
      ],
      note: `Verified Topstep Trading Combine preset. The ${size.accountSize / 1000}K Standard path has a $149 Express Funded Account activation fee. A fixed $${size.optionalDailyLossLimit.toLocaleString()} daily loss limit is optional at purchase. The MLL trails end-of-day balance highs and locks once it reaches the $${size.accountSize.toLocaleString()} starting balance.`,
    },
    {
      id: `topstep-trading-combine-${size.accountSize}-no-activation-fee-v1`,
      firm: 'Topstep',
      program: 'Trading Combine',
      path: 'no_activation_fee' as const,
      accountSize: size.accountSize,
      profitTarget: size.profitTarget,
      maximumLossLimit: size.maximumLossLimit,
      dailyLossLimit: null,
      optionalDailyLossLimit: size.optionalDailyLossLimit,
      responsibleTradingDiscount: size.responsibleTradingDiscount,
      responsibleTradingBenefit: 'Double payout caps after passing while the limited-time offer is active.',
      maximumContracts: size.maximumContracts,
      maximumMicros: size.maximumMicros,
      consistencyTargetPct: 50,
      minimumTradingDays: 2,
      drawdownType: 'eod_trailing' as const,
      trailingStopsAt: size.accountSize,
      activationFee: 0,
      monthlyPrice: size.noActivationPrice,
      version: 1,
      status: 'verified' as const,
      effectiveFrom: '2026-06-18',
      verifiedAt: '2026-06-22T00:00:00Z',
      sourceUrl: 'https://help.topstep.com/en/articles/8284197-trading-combine-parameters',
      secondarySourceUrls: [
        'https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit',
        'https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account',
        'https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions',
      ],
      note: `Verified Topstep Trading Combine preset. The ${size.accountSize / 1000}K No Activation Fee path has no Express Funded Account activation fee. A fixed $${size.optionalDailyLossLimit.toLocaleString()} daily loss limit is optional at purchase. The MLL trails end-of-day balance highs and locks once it reaches the $${size.accountSize.toLocaleString()} starting balance.`,
    },
  ])),
];

const TOPSTEP_TEMPLATES = TOPSTEP_RULES.map(ruleRecordToTemplate);

const STARTER_TEMPLATES: EvaluationTemplate[] = [
  ...TOPSTEP_TEMPLATES,
  // ── Topstep Trading Combine ─────────────────────────────────────────
  // Rules: trailing max loss, optional daily loss limit, 50% consistency rule, no min trading days
  // Source: topstep.com/trading-combine
  {
    id: 'topstep-50k',
    firm: 'Topstep',
    label: 'Topstep 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 1_000,
    maxDrawdown: 2_000,
    minimumTradingDays: 0,
    maxContracts: 5,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 50_000,
    note: 'MLL starts at $48,000 (2K below starting balance), trails end-of-day balance highs, and locks at $50,000. No minimum trading days. 50% consistency rule applies: no single day can account for more than 50% of total profit.',
  },
  {
    id: 'topstep-100k',
    firm: 'Topstep',
    label: 'Topstep 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 2_000,
    maxDrawdown: 3_000,
    minimumTradingDays: 0,
    maxContracts: 10,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 100_000,
    note: 'MLL starts at $97,000 (3K below starting balance), trails end-of-day balance highs, and locks at $100,000. No minimum trading days. 50% consistency rule applies.',
  },
  {
    id: 'topstep-150k',
    firm: 'Topstep',
    label: 'Topstep 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 3_000,
    maxDrawdown: 4_500,
    minimumTradingDays: 0,
    maxContracts: 15,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 150_000,
    note: 'MLL starts at $145,500 (4.5K below starting balance), trails end-of-day balance highs, and locks at $150,000. No minimum trading days. 50% consistency rule applies.',
  },

  // ── Apex Trader Funding (EOD evaluation accounts) ───────────────────
  // Verified Jul 2026 against apextraderfunding.com help center. EOD trailing:
  // the threshold ratchets on end-of-day balance highs only. On Rithmic
  // evaluations it locks at starting balance + profit target; on Tradovate it
  // trails without locking (we model the Rithmic lock). Funded PAs lock at
  // start + $100. Apex also sells intraday-trailing variants — override the
  // drawdown type on the account if yours is one. No daily loss limit.
  {
    id: 'apex-25k',
    firm: 'Apex Trader Funding',
    label: 'Apex 25K',
    accountSize: 25_000,
    profitTarget: 1_500,
    dailyLossLimit: 0,
    maxDrawdown: 1_500,
    minimumTradingDays: 1,
    maxContracts: 4,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 26_500,
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://apextraderfunding.com/help-center/eod-trailing-drawdown-accounts/eod-drawdown-explained/',
    note: 'EOD trailing threshold — ratchets on end-of-day balance highs and locks at $26,500 on Rithmic (Tradovate keeps trailing). No daily loss limit; minimum 1 trading day. Intraday-trailing account variants exist — override the drawdown type if yours is one.',
  },
  {
    id: 'apex-50k',
    firm: 'Apex Trader Funding',
    label: 'Apex 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 0,
    maxDrawdown: 2_500,
    minimumTradingDays: 1,
    maxContracts: 10,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 53_000,
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://apextraderfunding.com/help-center/eod-trailing-drawdown-accounts/eod-drawdown-explained/',
    note: 'EOD trailing threshold — ratchets on end-of-day balance highs and locks at $53,000 on Rithmic (Tradovate keeps trailing). No daily loss limit; minimum 1 trading day. Intraday-trailing account variants exist — override the drawdown type if yours is one.',
  },
  {
    id: 'apex-100k',
    firm: 'Apex Trader Funding',
    label: 'Apex 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 0,
    maxDrawdown: 3_000,
    minimumTradingDays: 1,
    maxContracts: 14,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 106_000,
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://apextraderfunding.com/help-center/eod-trailing-drawdown-accounts/eod-drawdown-explained/',
    note: 'EOD trailing threshold — ratchets on end-of-day balance highs and locks at $106,000 on Rithmic (Tradovate keeps trailing). No daily loss limit; minimum 1 trading day. Intraday-trailing account variants exist — override the drawdown type if yours is one.',
  },
  {
    id: 'apex-150k',
    firm: 'Apex Trader Funding',
    label: 'Apex 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 0,
    maxDrawdown: 5_000,
    minimumTradingDays: 1,
    maxContracts: 17,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 159_000,
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://apextraderfunding.com/help-center/eod-trailing-drawdown-accounts/eod-drawdown-explained/',
    note: 'EOD trailing threshold — ratchets on end-of-day balance highs and locks at $159,000 on Rithmic (Tradovate keeps trailing). No daily loss limit; minimum 1 trading day. Intraday-trailing account variants exist — override the drawdown type if yours is one.',
  },

  // ── FTMO Challenge (2-step) ─────────────────────────────────────────
  // Verified Jul 2026 against ftmo.com/en/trading-objectives: static drawdown
  // (max loss measured from initial balance, not peak), 10% profit target,
  // 5% daily loss, 10% max loss, minimum 4 trading days, no time limit.
  // The 1-step variant differs (3% daily) — use a custom account for that.
  {
    id: 'ftmo-10k',
    firm: 'FTMO',
    label: 'FTMO €10K',
    accountSize: 10_000,
    profitTarget: 1_000,
    dailyLossLimit: 500,
    maxDrawdown: 1_000,
    minimumTradingDays: 4,
    maxContracts: 0,
    consistencyLimitPct: null,
    drawdownType: 'static',
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://ftmo.com/en/trading-objectives/',
    note: 'Static drawdown measured from starting balance (not peak). 10% profit target, 5% daily loss, 10% max drawdown. Minimum 4 trading days. No contract limit (forex/CFD product).',
  },
  {
    id: 'ftmo-25k',
    firm: 'FTMO',
    label: 'FTMO €25K',
    accountSize: 25_000,
    profitTarget: 2_500,
    dailyLossLimit: 1_250,
    maxDrawdown: 2_500,
    minimumTradingDays: 4,
    maxContracts: 0,
    consistencyLimitPct: null,
    drawdownType: 'static',
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://ftmo.com/en/trading-objectives/',
    note: 'Static drawdown measured from starting balance. 10% profit target, 5% daily loss, 10% max drawdown. Minimum 4 trading days. No contract limit.',
  },
  {
    id: 'ftmo-50k',
    firm: 'FTMO',
    label: 'FTMO €50K',
    accountSize: 50_000,
    profitTarget: 5_000,
    dailyLossLimit: 2_500,
    maxDrawdown: 5_000,
    minimumTradingDays: 4,
    maxContracts: 0,
    consistencyLimitPct: null,
    drawdownType: 'static',
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://ftmo.com/en/trading-objectives/',
    note: 'Static drawdown measured from starting balance. 10% profit target, 5% daily loss, 10% max drawdown. Minimum 4 trading days. No contract limit.',
  },
  {
    id: 'ftmo-100k',
    firm: 'FTMO',
    label: 'FTMO €100K',
    accountSize: 100_000,
    profitTarget: 10_000,
    dailyLossLimit: 5_000,
    maxDrawdown: 10_000,
    minimumTradingDays: 4,
    maxContracts: 0,
    consistencyLimitPct: null,
    drawdownType: 'static',
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://ftmo.com/en/trading-objectives/',
    note: 'Static drawdown measured from starting balance. 10% profit target, 5% daily loss, 10% max drawdown. Minimum 4 trading days. No contract limit.',
  },
  {
    id: 'ftmo-200k',
    firm: 'FTMO',
    label: 'FTMO €200K',
    accountSize: 200_000,
    profitTarget: 20_000,
    dailyLossLimit: 10_000,
    maxDrawdown: 20_000,
    minimumTradingDays: 4,
    maxContracts: 0,
    consistencyLimitPct: null,
    drawdownType: 'static',
    status: 'verified',
    verifiedAt: '2026-07-22T00:00:00Z',
    sourceUrl: 'https://ftmo.com/en/trading-objectives/',
    note: 'Static drawdown measured from starting balance. 10% profit target, 5% daily loss, 10% max drawdown. Minimum 4 trading days. No contract limit.',
  },

  // ── MyFundedFutures (Rapid plan) ────────────────────────────────────
  // Updated Jul 2026: MFFU replaced Starter/Expert/Milestone with Core/Rapid/
  // Pro in Jul 2025. Rapid = intraday (real-time) trailing drawdown of 4%,
  // locks at starting balance + $100, no daily loss limit, minimum 2 trading
  // days. Status draft: numbers cross-checked against secondary sources only —
  // confirm contract limits in the MFFU dashboard.
  {
    id: 'mffu-50k',
    firm: 'MyFundedFutures',
    label: 'MyFundedFutures 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 0,
    maxDrawdown: 2_000,
    minimumTradingDays: 2,
    maxContracts: 4,
    consistencyLimitPct: null,
    drawdownType: 'intraday_trailing',
    trailingStopsAt: 50_100,
    status: 'draft',
    sourceUrl: 'https://myfundedfutures.com',
    note: 'Rapid plan. Real-time trailing drawdown (follows live equity including open-trade peaks, which Flyxa cannot see from closed trades) — locks at $50,100. No daily loss limit. Minimum 2 trading days. Verify contract limits in your MFFU dashboard.',
  },
  {
    id: 'mffu-100k',
    firm: 'MyFundedFutures',
    label: 'MyFundedFutures 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 0,
    maxDrawdown: 4_000,
    minimumTradingDays: 2,
    maxContracts: 10,
    consistencyLimitPct: null,
    drawdownType: 'intraday_trailing',
    trailingStopsAt: 100_100,
    status: 'draft',
    sourceUrl: 'https://myfundedfutures.com',
    note: 'Rapid plan. Real-time trailing drawdown (follows live equity including open-trade peaks, which Flyxa cannot see from closed trades) — locks at $100,100. No daily loss limit. Minimum 2 trading days. Verify contract limits in your MFFU dashboard.',
  },
  {
    id: 'mffu-150k',
    firm: 'MyFundedFutures',
    label: 'MyFundedFutures 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 0,
    maxDrawdown: 6_000,
    minimumTradingDays: 2,
    maxContracts: 15,
    consistencyLimitPct: null,
    drawdownType: 'intraday_trailing',
    trailingStopsAt: 150_100,
    status: 'draft',
    sourceUrl: 'https://myfundedfutures.com',
    note: 'Rapid plan. Real-time trailing drawdown (follows live equity including open-trade peaks, which Flyxa cannot see from closed trades) — locks at $150,100. No daily loss limit. Minimum 2 trading days. Verify contract limits in your MFFU dashboard.',
  },

  // ── Take Profit Trader (Test) ───────────────────────────────────────
  // Researched Jul 2026: one-step Test, EOD trailing drawdown, daily loss
  // limit removed on all sizes, minimum 5 trading days, 50% consistency.
  // Draft: numbers from consistent secondary sources + TPT help center.
  {
    id: 'tpt-25k',
    firm: 'Take Profit Trader',
    program: 'Test',
    label: 'Take Profit Trader 25K',
    accountSize: 25_000,
    profitTarget: 1_500,
    dailyLossLimit: 0,
    maxDrawdown: 1_500,
    minimumTradingDays: 5,
    maxContracts: 3,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 25_000,
    status: 'draft',
    sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/categories/15135982702621-Test-Rules',
    note: 'One-step Test. EOD trailing drawdown (funded PRO accounts trail intraday instead). No daily loss limit. Minimum 5 trading days; no day may exceed 50% of total profit. Lock at the starting balance is modeled — verify in the TPT dashboard.',
  },
  {
    id: 'tpt-50k',
    firm: 'Take Profit Trader',
    program: 'Test',
    label: 'Take Profit Trader 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 0,
    maxDrawdown: 2_000,
    minimumTradingDays: 5,
    maxContracts: 6,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 50_000,
    status: 'draft',
    sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/categories/15135982702621-Test-Rules',
    note: 'One-step Test. EOD trailing drawdown (funded PRO accounts trail intraday instead). No daily loss limit. Minimum 5 trading days; no day may exceed 50% of total profit. Lock at the starting balance is modeled — verify in the TPT dashboard.',
  },
  {
    id: 'tpt-75k',
    firm: 'Take Profit Trader',
    program: 'Test',
    label: 'Take Profit Trader 75K',
    accountSize: 75_000,
    profitTarget: 4_500,
    dailyLossLimit: 0,
    maxDrawdown: 3_000,
    minimumTradingDays: 5,
    maxContracts: 9,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 75_000,
    status: 'draft',
    sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/categories/15135982702621-Test-Rules',
    note: 'One-step Test. EOD trailing drawdown (funded PRO accounts trail intraday instead). No daily loss limit. Minimum 5 trading days; no day may exceed 50% of total profit. Lock at the starting balance is modeled — verify in the TPT dashboard.',
  },
  {
    id: 'tpt-100k',
    firm: 'Take Profit Trader',
    program: 'Test',
    label: 'Take Profit Trader 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 0,
    maxDrawdown: 4_000,
    minimumTradingDays: 5,
    maxContracts: 12,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 100_000,
    status: 'draft',
    sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/categories/15135982702621-Test-Rules',
    note: 'One-step Test. EOD trailing drawdown (funded PRO accounts trail intraday instead). No daily loss limit. Minimum 5 trading days; no day may exceed 50% of total profit. Lock at the starting balance is modeled — verify in the TPT dashboard.',
  },
  {
    id: 'tpt-150k',
    firm: 'Take Profit Trader',
    program: 'Test',
    label: 'Take Profit Trader 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 0,
    maxDrawdown: 4_500,
    minimumTradingDays: 5,
    maxContracts: 15,
    consistencyLimitPct: 50,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 150_000,
    status: 'draft',
    sourceUrl: 'https://takeprofittraderhelp.zendesk.com/hc/en-us/categories/15135982702621-Test-Rules',
    note: 'One-step Test. EOD trailing drawdown (funded PRO accounts trail intraday instead). No daily loss limit. Minimum 5 trading days; no day may exceed 50% of total profit. Lock at the starting balance is modeled — verify in the TPT dashboard.',
  },

  // ── Lucid Trading (LucidPro) ────────────────────────────────────────
  // Researched Jul 2026. EOD trailing MLL that updates only at market close
  // and locks once the balance exceeds the Initial Trail Balance (modeled as
  // the starting balance). No consistency rule on LucidPro evaluations.
  // Draft: secondary sources conflict on minimum days (1 vs 5) — verify.
  {
    id: 'lucid-25k',
    firm: 'Lucid Trading',
    program: 'LucidPro',
    label: 'Lucid 25K',
    accountSize: 25_000,
    profitTarget: 1_250,
    dailyLossLimit: 0,
    maxDrawdown: 1_000,
    minimumTradingDays: 1,
    maxContracts: 2,
    maxMicros: 20,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 25_000,
    status: 'draft',
    sourceUrl: 'https://lucidtrading.com',
    note: 'LucidPro. EOD trailing MLL — updates at market close only and locks once the balance clears the Initial Trail Balance. No daily loss limit on the 25K. No consistency rule. Sources conflict on minimum days (1 vs 5) — verify in your Lucid dashboard.',
  },
  {
    id: 'lucid-50k',
    firm: 'Lucid Trading',
    program: 'LucidPro',
    label: 'Lucid 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 1_200,
    maxDrawdown: 2_000,
    minimumTradingDays: 1,
    maxContracts: 4,
    maxMicros: 40,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 50_000,
    status: 'draft',
    sourceUrl: 'https://lucidtrading.com',
    note: 'LucidPro. EOD trailing MLL — updates at market close only and locks once the balance clears the Initial Trail Balance. $1,200 fixed daily loss limit. No consistency rule. Sources conflict on minimum days (1 vs 5) — verify in your Lucid dashboard.',
  },
  {
    id: 'lucid-100k',
    firm: 'Lucid Trading',
    program: 'LucidPro',
    label: 'Lucid 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 1_800,
    maxDrawdown: 3_000,
    minimumTradingDays: 1,
    maxContracts: 6,
    maxMicros: 60,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 100_000,
    status: 'draft',
    sourceUrl: 'https://lucidtrading.com',
    note: 'LucidPro. EOD trailing MLL — updates at market close only and locks once the balance clears the Initial Trail Balance. $1,800 fixed daily loss limit. No consistency rule. Sources conflict on minimum days (1 vs 5) — verify in your Lucid dashboard.',
  },
  {
    id: 'lucid-150k',
    firm: 'Lucid Trading',
    program: 'LucidPro',
    label: 'Lucid 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 2_700,
    maxDrawdown: 4_500,
    minimumTradingDays: 1,
    maxContracts: 10,
    maxMicros: 100,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: 150_000,
    status: 'draft',
    sourceUrl: 'https://lucidtrading.com',
    note: 'LucidPro. EOD trailing MLL — updates at market close only and locks once the balance clears the Initial Trail Balance. $2,700 fixed daily loss limit. No consistency rule. Sources conflict on minimum days (1 vs 5) — verify in your Lucid dashboard.',
  },

  // ── Tradeify (Growth) ───────────────────────────────────────────────
  // Researched Jul 2026. Growth: EOD trailing drawdown that does NOT lock
  // during the evaluation (funded accounts lock at start + $100), fixed daily
  // loss limit, no consistency rule, minimum 1 day. The Select plan differs
  // (no DLL, 40% consistency, 3 min days) — use a custom account for Select.
  {
    id: 'tradeify-growth-25k',
    firm: 'Tradeify',
    program: 'Growth',
    label: 'Tradeify Growth 25K',
    accountSize: 25_000,
    profitTarget: 1_500,
    dailyLossLimit: 600,
    maxDrawdown: 1_000,
    minimumTradingDays: 1,
    maxContracts: 1,
    maxMicros: 10,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://help.tradeify.co/en/collections/11501721-accounts-rules',
    note: 'Growth plan. EOD trailing drawdown — keeps trailing through the whole evaluation (locks at start + $100 only once funded). $600 fixed daily loss limit. No consistency rule; minimum 1 trading day.',
  },
  {
    id: 'tradeify-growth-50k',
    firm: 'Tradeify',
    program: 'Growth',
    label: 'Tradeify Growth 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 1_250,
    maxDrawdown: 2_000,
    minimumTradingDays: 1,
    maxContracts: 4,
    maxMicros: 40,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://help.tradeify.co/en/collections/11501721-accounts-rules',
    note: 'Growth plan. EOD trailing drawdown — keeps trailing through the whole evaluation (locks at start + $100 only once funded). $1,250 fixed daily loss limit. No consistency rule; minimum 1 trading day.',
  },
  {
    id: 'tradeify-growth-100k',
    firm: 'Tradeify',
    program: 'Growth',
    label: 'Tradeify Growth 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 2_500,
    maxDrawdown: 3_500,
    minimumTradingDays: 1,
    maxContracts: 8,
    maxMicros: 80,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://help.tradeify.co/en/collections/11501721-accounts-rules',
    note: 'Growth plan. EOD trailing drawdown — keeps trailing through the whole evaluation (locks at start + $100 only once funded). $2,500 fixed daily loss limit. No consistency rule; minimum 1 trading day.',
  },
  {
    id: 'tradeify-growth-150k',
    firm: 'Tradeify',
    program: 'Growth',
    label: 'Tradeify Growth 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 3_750,
    maxDrawdown: 5_000,
    minimumTradingDays: 1,
    maxContracts: 12,
    maxMicros: 120,
    consistencyLimitPct: null,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://help.tradeify.co/en/collections/11501721-accounts-rules',
    note: 'Growth plan. EOD trailing drawdown — keeps trailing through the whole evaluation (locks at start + $100 only once funded). $3,750 fixed daily loss limit. No consistency rule; minimum 1 trading day.',
  },

  // ── TradeDay ────────────────────────────────────────────────────────
  // Researched Jul 2026. One rule in the evaluation: never breach the EOD
  // trailing max drawdown (ratchets at the 4 PM CT settlement). No daily loss
  // limit; minimum 5 trading days; 30% consistency during the evaluation only.
  {
    id: 'tradeday-50k',
    firm: 'TradeDay',
    label: 'TradeDay 50K',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 0,
    maxDrawdown: 2_000,
    minimumTradingDays: 5,
    maxContracts: 5,
    consistencyLimitPct: 30,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://www.tradeday.com',
    note: 'EOD trailing max drawdown — ratchets at the 4 PM CT settlement and applies through both evaluation and funded stages. No daily loss limit. Minimum 5 trading days; no single day above 30% of total profit during the evaluation.',
  },
  {
    id: 'tradeday-100k',
    firm: 'TradeDay',
    label: 'TradeDay 100K',
    accountSize: 100_000,
    profitTarget: 6_000,
    dailyLossLimit: 0,
    maxDrawdown: 3_000,
    minimumTradingDays: 5,
    maxContracts: 10,
    consistencyLimitPct: 30,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://www.tradeday.com',
    note: 'EOD trailing max drawdown — ratchets at the 4 PM CT settlement and applies through both evaluation and funded stages. No daily loss limit. Minimum 5 trading days; no single day above 30% of total profit during the evaluation.',
  },
  {
    id: 'tradeday-150k',
    firm: 'TradeDay',
    label: 'TradeDay 150K',
    accountSize: 150_000,
    profitTarget: 9_000,
    dailyLossLimit: 0,
    maxDrawdown: 4_500,
    minimumTradingDays: 5,
    maxContracts: 15,
    consistencyLimitPct: 30,
    drawdownType: 'eod_trailing',
    trailingStopsAt: null,
    status: 'draft',
    sourceUrl: 'https://www.tradeday.com',
    note: 'EOD trailing max drawdown — ratchets at the 4 PM CT settlement and applies through both evaluation and funded stages. No daily loss limit. Minimum 5 trading days; no single day above 30% of total profit during the evaluation.',
  },

  // ── Custom ──────────────────────────────────────────────────────────
  {
    id: 'custom-evaluation',
    firm: 'Custom',
    label: 'Custom evaluation',
    accountSize: 50_000,
    profitTarget: 3_000,
    dailyLossLimit: 1_000,
    maxDrawdown: 2_000,
    minimumTradingDays: 5,
    maxContracts: 5,
    consistencyLimitPct: null,
    drawdownType: 'static',
    note: 'Edit the account limits to match the exact rules supplied by your firm.',
  },
];

export function getEvaluationTemplates(): EvaluationTemplate[] {
  const legacyTopstepIds = new Set(['topstep-50k', 'topstep-100k', 'topstep-150k']);
  return STARTER_TEMPLATES.filter(template => !legacyTopstepIds.has(template.id));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function inferEvaluationTemplate(account: Account): EvaluationTemplate {
  const templates = getEvaluationTemplates();
  const configured = templates.find(template => template.id === account.evaluationTemplateId);
  if (configured) return configured;
  if (account.evaluationTemplateId?.startsWith('topstep-')) {
    const legacy = templates.find(template => template.firm === 'Topstep' && template.accountSize === account.size);
    if (legacy) return legacy;
  }
  const firm = normalized(`${account.firm} ${account.name}`);
  const firmMatches = templates.filter(template => firm.includes(normalized(template.firm)));
  return firmMatches.find(template => template.accountSize === account.size && (
    !account.evaluationPath || template.path === account.evaluationPath
  ))
    ?? firmMatches.find(template => template.accountSize === account.size)
    ?? firmMatches[0]
    ?? templates[templates.length - 1];
}

export function tradesForAccount(trades: Trade[], accountId: string): Trade[] {
  return trades.filter(trade => trade.account === accountId || trade.accountIds?.includes(accountId));
}

function net(trade: Trade): number {
  return Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function dateTime(trade: Trade): number {
  const parsed = new Date(`${trade.date}T${trade.time || '00:00'}:00`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDateSlice(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveDrawdownType(account: Account, template: EvaluationTemplate): 'static' | 'eod_trailing' | 'intraday_trailing' {
  const raw = account.drawdownType ?? template.drawdownType;
  return raw === 'trailing' ? 'intraday_trailing' : raw;
}

function resolveTrailingStopsAt(account: Account, template: EvaluationTemplate): number | null {
  return account.trailingStopsAt ?? template.trailingStopsAt ?? null;
}

/**
 * The MLL over time, aligned with the equity sparkline: index 0 is the floor
 * before any trading, then one value per trading day (ascending), sampled as
 * that day settles. The floor only ratchets up, and locks at trailingStopsAt.
 *
 * EOD-trailing floors ignore the current (unsettled) day's balance, so the
 * last value always equals the live drawdownFloor in EvaluationProgress.
 */
export function computeMllSeries(account: Account, allTrades: Trade[], now = new Date()): number[] {
  const trades = tradesForAccount(allTrades, account.id).sort((a, b) => dateTime(a) - dateTime(b));
  const template = inferEvaluationTemplate(account);
  const maxDrawdown = account.maxDrawdown || template.maxDrawdown;
  const drawdownType = resolveDrawdownType(account, template);
  const trailingStopsAt = resolveTrailingStopsAt(account, template);
  const today = localDateSlice(now);
  const startingFloor = account.startingBalance - maxDrawdown;

  const floors: number[] = [startingFloor];
  let equity = account.startingBalance;
  let intradayPeak = equity;
  let eodPeak = equity;
  trades.forEach((trade, index) => {
    equity += net(trade);
    intradayPeak = Math.max(intradayPeak, equity);
    const lastOfDay = trades[index + 1]?.date !== trade.date;
    if (!lastOfDay) return;
    if (drawdownType === 'static') {
      floors.push(startingFloor);
      return;
    }
    if (trade.date !== today) eodPeak = Math.max(eodPeak, equity);
    const peak = drawdownType === 'intraday_trailing' ? intradayPeak : eodPeak;
    let floor = peak - maxDrawdown;
    if (trailingStopsAt !== null) floor = Math.min(floor, trailingStopsAt);
    floors.push(Math.max(startingFloor, floor));
  });
  return floors;
}

export function computeEvaluationProgress(
  account: Account,
  allTrades: Trade[],
  now = new Date(),
): EvaluationProgress {
  const trades = tradesForAccount(allTrades, account.id).sort((a, b) => dateTime(a) - dateTime(b));
  const template = inferEvaluationTemplate(account);
  const profitTarget = account.profitTarget ?? template.profitTarget;
  const dailyLimit = account.dailyLossLimit || template.dailyLossLimit;
  const maxDrawdown = account.maxDrawdown || template.maxDrawdown;
  const minimumTradingDays = account.minimumTradingDays ?? template.minimumTradingDays;
  const drawdownType = resolveDrawdownType(account, template);
  const trailingStopsAt = resolveTrailingStopsAt(account, template);
  const netPnl = trades.reduce((sum, trade) => sum + net(trade), 0);
  const currentBalance = account.startingBalance + netPnl;
  const today = localDateSlice(now);
  const dailyPnl = trades.filter(trade => trade.date === today).reduce((sum, trade) => sum + net(trade), 0);
  const tradingDays = new Set(trades.map(trade => trade.date)).size;

  const targetProgressPct = profitTarget > 0 ? clamp((netPnl / profitTarget) * 100) : 0;
  const mllSeries = computeMllSeries(account, allTrades, now);
  const drawdownFloor = mllSeries[mllSeries.length - 1];
  const floorLocked = trailingStopsAt !== null && drawdownFloor >= trailingStopsAt;
  const drawdownRemaining = Math.max(0, currentBalance - drawdownFloor);
  const drawdownUsed = Math.max(0, maxDrawdown - drawdownRemaining);
  const dailyLossRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit + Math.min(0, dailyPnl)) : Infinity;
  const violations = trades.flatMap(trade => trade.performanceViolations ?? []);
  const criticalViolations = violations.filter(item => item.severity === 'critical').length;
  const recentTrades = trades.slice(-20);
  const recentWins = recentTrades.filter(trade => net(trade) > 0).length;
  const recentWinRate = recentTrades.length ? recentWins / recentTrades.length : 0.5;
  const positiveDays = new Set(
    trades.filter(trade => net(trade) > 0).map(trade => trade.date),
  ).size;
  const dayQuality = tradingDays ? positiveDays / tradingDays : 0.5;
  const targetScore = targetProgressPct;
  const survivalScore = maxDrawdown > 0 ? clamp((drawdownRemaining / maxDrawdown) * 100) : 100;
  const sampleScore = clamp((tradingDays / Math.max(1, minimumTradingDays)) * 100);
  const behaviorScore = clamp(100 - criticalViolations * 22 - violations.length * 5);
  const passProbability = Math.round(clamp(
    targetScore * 0.36
      + survivalScore * 0.26
      + sampleScore * 0.12
      + recentWinRate * 100 * 0.12
      + dayQuality * 100 * 0.08
      + behaviorScore * 0.06,
  ));

  const warnings: string[] = [];
  if (dailyLimit > 0 && dailyLossRemaining <= dailyLimit * 0.25) warnings.push(`Only $${Math.round(dailyLossRemaining).toLocaleString()} remains before the daily-loss limit.`);
  if (maxDrawdown > 0 && drawdownRemaining <= maxDrawdown * 0.25) warnings.push(`Only $${Math.round(drawdownRemaining).toLocaleString()} of drawdown room remains.`);
  if (account.maxContracts && trades.some(trade => trade.contracts > account.maxContracts!)) warnings.push('At least one trade exceeded the configured contract limit.');
  if (criticalViolations) warnings.push(`${criticalViolations} critical process violation${criticalViolations === 1 ? '' : 's'} recorded.`);

  const passed = netPnl >= profitTarget && tradingDays >= minimumTradingDays && criticalViolations === 0;
  const violated = (dailyLimit > 0 && dailyLossRemaining <= 0) || drawdownRemaining <= 0;
  const status: EvaluationProgress['status'] = passed
    ? 'passed'
    : violated
      ? 'violated'
      : warnings.length
        ? 'at-risk'
        : 'on-track';

  return {
    accountId: account.id,
    netPnl,
    currentBalance,
    targetRemaining: Math.max(0, profitTarget - netPnl),
    targetProgressPct,
    dailyPnl,
    dailyLossRemaining,
    drawdownFloor,
    drawdownUsed,
    drawdownRemaining,
    drawdownType,
    trailingStopsAt,
    floorLocked,
    tradingDays,
    minimumTradingDays,
    passProbability,
    probabilityFactors: {
      targetScore: Math.round(targetScore),
      survivalScore: Math.round(survivalScore),
      recentWinRate: Math.round(recentWinRate * 100),
      dayQuality: Math.round(dayQuality * 100),
    },
    status,
    warnings,
  };
}

// When the previous trade was closed. `time` is the ENTRY time, so measuring
// re-entry gaps from it overstates the wait on long-held trades — prefer the
// recorded exit time, then entry + duration, then entry as the last resort.
function exitDateTime(trade: Trade): number {
  const entry = dateTime(trade);
  if (trade.exitTime) {
    const parsed = new Date(`${trade.date}T${trade.exitTime}:00`).getTime();
    // An exit clock earlier than entry means the trade closed past midnight.
    if (Number.isFinite(parsed)) return parsed < entry ? parsed + 86_400_000 : parsed;
  }
  const duration = trade.duration ?? trade.durationMinutes;
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return entry + duration * 60_000;
  }
  return entry;
}

// Minutes the trader actually waited: previous trade's close → next entry.
function minutesBetween(previous: Trade, current: Trade): number {
  return Math.max(0, (dateTime(current) - exitDateTime(previous)) / 60_000);
}

export interface SessionWindows {
  asia?: { start: string; end: string };
  london?: { start: string; end: string };
  preMarket?: { start: string; end: string };
  newYork?: { start: string; end: string };
}

function timeToMinutes(time: string | undefined): number | null {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function inWindow(minutes: number, window?: { start: string; end: string }): boolean {
  const start = timeToMinutes(window?.start);
  const end = timeToMinutes(window?.end);
  if (start === null || end === null || start === end) return false;
  // An end before the start means the window crosses midnight (e.g. Asia).
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

// Buckets a trade's entry clock into the user's configured session windows.
// The hour-based split is only a fallback for callers without preferences.
function sessionName(time: string, windows?: SessionWindows): string {
  const minutes = timeToMinutes(time);
  if (minutes === null) return 'off-session';
  if (windows) {
    if (inWindow(minutes, windows.newYork)) return 'New York';
    if (inWindow(minutes, windows.london)) return 'London';
    if (inWindow(minutes, windows.preMarket)) return 'pre-market';
    if (inWindow(minutes, windows.asia)) return 'Asia';
    return 'off-session';
  }
  const hour = Math.floor(minutes / 60);
  if (hour >= 2 && hour < 8) return 'London';
  if (hour >= 8 && hour < 13) return 'New York';
  return 'off-session';
}

export function buildEvaluationAgentAlerts(
  account: Account,
  allTrades: Trade[],
  progress: EvaluationProgress,
  sessionWindows?: SessionWindows,
): EvaluationAgentAlert[] {
  const trades = tradesForAccount(allTrades, account.id).sort((a, b) => dateTime(a) - dateTime(b));
  const alerts: EvaluationAgentAlert[] = [];
  const postLoss: Array<{ trade: Trade; wait: number }> = [];
  for (let index = 1; index < trades.length; index += 1) {
    const previous = trades[index - 1];
    const current = trades[index];
    if (previous.date === current.date && net(previous) < 0) {
      postLoss.push({ trade: current, wait: minutesBetween(previous, current) });
    }
  }

  const immediate = postLoss.filter(item => item.wait < 20);
  const waited = postLoss.filter(item => item.wait >= 20);
  const immediatePnl = immediate.reduce((sum, item) => sum + net(item.trade), 0);
  const waitedPnl = waited.reduce((sum, item) => sum + net(item.trade), 0);
  if (immediate.length >= 2 && immediatePnl < 0) {
    const monthlyCost = Math.round(Math.abs(immediatePnl / immediate.length) * Math.max(4, immediate.length));
    alerts.push({
      id: 'post-loss-cost',
      severity: 'critical',
      title: 'Post-loss trading is leaking money',
      message: `Your first trade within 20 minutes of a loss is costing an estimated $${monthlyCost.toLocaleString()} per month.`,
      action: 'Enforce a 20-minute reset after every losing trade.',
    });
  }
  if (waited.length >= 2 && immediate.length >= 2) {
    const immediateAvg = immediatePnl / immediate.length;
    const waitedAvg = waitedPnl / waited.length;
    if (waitedAvg > immediateAvg) {
      alerts.push({
        id: 'wait-20',
        severity: 'info',
        title: 'Waiting improves your next decision',
        message: `After waiting 20 minutes, your next-trade average improves by $${Math.round(waitedAvg - immediateAvg).toLocaleString()}.`,
        action: 'Start the reset timer immediately after a loss.',
      });
    }
  }

  // Hold-time asymmetry — sitting in losers while cutting winners is the
  // classic disposition leak. Only measurable on trades with known durations.
  const holdMinutes = (trade: Trade): number | null => {
    if (typeof trade.duration === 'number' && trade.duration > 0) return trade.duration;
    if (typeof trade.durationMinutes === 'number' && trade.durationMinutes > 0) return trade.durationMinutes;
    return null;
  };
  const winHolds = trades.filter(trade => net(trade) > 0).map(holdMinutes).filter((v): v is number => v !== null);
  const lossHolds = trades.filter(trade => net(trade) < 0).map(holdMinutes).filter((v): v is number => v !== null);
  if (winHolds.length >= 3 && lossHolds.length >= 3) {
    const avgWinHold = winHolds.reduce((sum, v) => sum + v, 0) / winHolds.length;
    const avgLossHold = lossHolds.reduce((sum, v) => sum + v, 0) / lossHolds.length;
    if (avgWinHold > 0 && avgLossHold > avgWinHold * 1.5) {
      alerts.push({
        id: 'hold-time-asymmetry',
        severity: 'warning',
        title: 'Losers are held longer than winners',
        message: `Average losing hold is ${Math.round(avgLossHold)} minutes vs ${Math.round(avgWinHold)} for winners (${(avgLossHold / avgWinHold).toFixed(1)}×). That is hoping, not managing.`,
        action: 'Exit at your invalidation — put a hard time stop on losing trades.',
      });
    }
  }

  const sessions = new Map<string, Trade[]>();
  trades.forEach(trade => {
    const label = sessionName(trade.time, sessionWindows);
    sessions.set(label, [...(sessions.get(label) ?? []), trade]);
  });
  sessions.forEach((items, label) => {
    const pnl = items.reduce((sum, trade) => sum + net(trade), 0);
    if (label !== 'off-session' && items.length >= 4 && pnl < 0) {
      alerts.push({
        id: `session-${label.toLowerCase().replace(/\s/g, '-')}`,
        severity: 'warning',
        title: `${label} needs a condition`,
        message: `Do not trade ${label} tomorrow unless your written setup and risk checklist both pass. This window is down $${Math.round(Math.abs(pnl)).toLocaleString()} across ${items.length} trades.`,
        action: `Require an A-grade setup before trading ${label}.`,
      });
    }
  });

  if (progress.status === 'violated' || progress.drawdownRemaining <= Math.max(100, account.maxDrawdown * 0.15)) {
    alerts.unshift({
      id: 'behavioral-risk-limit',
      severity: 'critical',
      title: 'Behavioral risk limit reached',
      message: `You have $${Math.round(progress.drawdownRemaining).toLocaleString()} of drawdown room remaining. New risk is no longer justified by the evaluation state.`,
      action: 'Stand down and review the last five trades before the next session.',
    });
  } else if (progress.warnings.length) {
    alerts.unshift({
      id: 'evaluation-warning',
      severity: 'warning',
      title: 'Evaluation buffer is narrowing',
      message: progress.warnings[0],
      action: 'Reduce exposure and protect evaluation survival.',
    });
  }

  return alerts.slice(0, 5);
}

// ─── Day verdict ──────────────────────────────────────────────────────────────

export interface DayVerdict {
  verdict: 'yes' | 'caution' | 'no';
  reason: string;
}

const VERDICT_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function computeDayVerdict(
  accountTrades: Trade[],
  drawdownRemainingPct: number,
  dailyLimitHit: boolean,
): DayVerdict {
  const sorted = [...accountTrades].sort((a, b) =>
    (b.date ?? '').localeCompare(a.date ?? '') || (b.time ?? '').localeCompare(a.time ?? ''),
  );

  const last3Losses = sorted.length >= 3 && sorted.slice(0, 3).every(t => (t.pnl ?? 0) < 0);

  const byDate = new Map<string, number>();
  for (const t of accountTrades) {
    byDate.set(t.date, (byDate.get(t.date) ?? 0) + (t.pnl ?? 0));
  }
  const dayDates = [...byDate.keys()].sort().reverse();
  const last2AllNeg = dayDates.length >= 2 && dayDates.slice(0, 2).every(d => (byDate.get(d) ?? 0) < 0);

  const byDow = new Map<string, number[]>();
  for (const t of accountTrades) {
    if (!t.date) continue;
    const d = new Date(`${t.date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    const dow = VERDICT_DOW[d.getDay()];
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow)!.push(t.pnl ?? 0);
  }
  const todayDow = VERDICT_DOW[new Date().getDay()];
  const todayDowData = byDow.get(todayDow);
  const dowSum = (ps: number[]) => ps.reduce((s, p) => s + p, 0);
  const allDowNets = [...byDow.entries()].filter(([, ps]) => ps.length >= 3).map(([, ps]) => dowSum(ps));
  const worstDowNet = allDowNets.length ? Math.min(...allDowNets) : 0;
  const todayIsWorstDow = !!todayDowData && todayDowData.length >= 3
    && dowSum(todayDowData) === worstDowNet && worstDowNet < -100;

  if (drawdownRemainingPct < 20 || dailyLimitHit || last3Losses) {
    if (drawdownRemainingPct < 20) {
      return { verdict: 'no', reason: `Only ${drawdownRemainingPct}% buffer remaining — account at critical risk. Sit out and review.` };
    }
    if (dailyLimitHit) {
      return { verdict: 'no', reason: 'Daily loss limit reached. No more trading today.' };
    }
    return { verdict: 'no', reason: 'Last 3 trades were all losses. Step away — review setup criteria before re-entering.' };
  }

  if (drawdownRemainingPct < 40 || last2AllNeg || todayIsWorstDow) {
    if (drawdownRemainingPct < 40) {
      return { verdict: 'caution', reason: `Buffer at ${drawdownRemainingPct}% — use reduced size and only take A+ setups today.` };
    }
    if (last2AllNeg) {
      return { verdict: 'caution', reason: 'Last 2 sessions were net negative. Tighten criteria — wait for high-confluence entries only.' };
    }
    return { verdict: 'caution', reason: `${todayDow}s are your weakest day in this eval. Be selective — only your highest-edge setups.` };
  }

  return { verdict: 'yes', reason: `Buffer healthy at ${drawdownRemainingPct}%. Trade your plan and protect the buffer.` };
}
