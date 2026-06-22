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
  drawdownType: 'trailing';
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

const VERIFIED_AT = '2026-06-22T00:00:00Z';
const EFFECTIVE_FROM = '2026-06-18';
const PARAMETERS_URL = 'https://help.topstep.com/en/articles/8284197-trading-combine-parameters';
const SOURCE_URLS = [
  'https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit',
  'https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account',
  'https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions',
];

const SIZES = [
  { accountSize: 50_000, profitTarget: 3_000, maximumLossLimit: 2_000, optionalDailyLossLimit: 1_000, responsibleTradingDiscount: 10, maximumContracts: 5, maximumMicros: 50, standardPrice: 49, noActivationPrice: 95 },
  { accountSize: 100_000, profitTarget: 6_000, maximumLossLimit: 3_000, optionalDailyLossLimit: 2_000, responsibleTradingDiscount: 20, maximumContracts: 10, maximumMicros: 100, standardPrice: 99, noActivationPrice: 149 },
  { accountSize: 150_000, profitTarget: 9_000, maximumLossLimit: 4_500, optionalDailyLossLimit: 3_000, responsibleTradingDiscount: 30, maximumContracts: 15, maximumMicros: 150, standardPrice: 199, noActivationPrice: 229 },
] as const;

export const TOPSTEP_RULES: PropFirmRuleRecord[] = SIZES.flatMap(size => ([
  {
    id: `topstep-trading-combine-${size.accountSize}-standard-v1`,
    firm: 'Topstep',
    program: 'Trading Combine',
    path: 'standard',
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
    drawdownType: 'trailing',
    activationFee: 149,
    monthlyPrice: size.standardPrice,
    version: 1,
    status: 'verified',
    effectiveFrom: EFFECTIVE_FROM,
    verifiedAt: VERIFIED_AT,
    sourceUrl: PARAMETERS_URL,
    secondarySourceUrls: SOURCE_URLS,
    note: `Standard path. $149 activation fee after passing. Optional fixed daily loss limit: $${size.optionalDailyLossLimit.toLocaleString('en-US')}.`,
  },
  {
    id: `topstep-trading-combine-${size.accountSize}-no-activation-fee-v1`,
    firm: 'Topstep',
    program: 'Trading Combine',
    path: 'no_activation_fee',
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
    drawdownType: 'trailing',
    activationFee: 0,
    monthlyPrice: size.noActivationPrice,
    version: 1,
    status: 'verified',
    effectiveFrom: EFFECTIVE_FROM,
    verifiedAt: VERIFIED_AT,
    sourceUrl: PARAMETERS_URL,
    secondarySourceUrls: SOURCE_URLS,
    note: `No Activation Fee path. $0 activation fee after passing. Optional fixed daily loss limit: $${size.optionalDailyLossLimit.toLocaleString('en-US')}.`,
  },
] satisfies PropFirmRuleRecord[]));

export function mapRuleRow(row: Record<string, unknown>): PropFirmRuleRecord {
  return {
    id: String(row.id),
    firm: String(row.firm_name ?? row.firm),
    program: String(row.program),
    path: row.path === 'no_activation_fee' ? 'no_activation_fee' : 'standard',
    accountSize: Number(row.account_size),
    profitTarget: Number(row.profit_target),
    maximumLossLimit: Number(row.maximum_loss_limit),
    dailyLossLimit: row.daily_loss_limit == null ? null : Number(row.daily_loss_limit),
    optionalDailyLossLimit: row.optional_daily_loss_limit == null ? null : Number(row.optional_daily_loss_limit),
    responsibleTradingDiscount: Number(row.responsible_trading_discount ?? 0),
    responsibleTradingBenefit: String(row.responsible_trading_benefit ?? ''),
    maximumContracts: Number(row.maximum_contracts),
    maximumMicros: Number(row.maximum_micros),
    consistencyTargetPct: Number(row.consistency_target_pct),
    minimumTradingDays: Number(row.minimum_trading_days),
    drawdownType: 'trailing',
    activationFee: Number(row.activation_fee),
    monthlyPrice: Number(row.monthly_price),
    version: Number(row.version),
    status: row.status === 'draft' || row.status === 'retired' ? row.status : 'verified',
    effectiveFrom: String(row.effective_from),
    verifiedAt: String(row.verified_at),
    sourceUrl: String(row.source_url),
    secondarySourceUrls: Array.isArray(row.secondary_source_urls)
      ? row.secondary_source_urls.map(String)
      : [],
    note: String(row.note ?? ''),
  };
}
