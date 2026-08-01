export type TradeDirection = 'LONG' | 'SHORT';
export type TradeResult = 'win' | 'loss' | 'open' | 'be';
export type RuleState = 'ok' | 'fail' | 'unchecked';
export type EmotionState = 'neutral' | 'green' | 'amber' | 'red';

export interface TradeReflection {
  thesis: string;
  execution: string;
  adjustment: string;
  processGrade: number;
  followedPlan: boolean | null;
  followedPlanLogged?: boolean;
}

export interface Trade {
  id: string;
  entryId: string;
  date: string;
  symbol: string;
  direction: TradeDirection;
  entry: number;
  sl: number;
  tp: number;
  exit: number | null;
  contracts: number;
  rr: number;
  pnl: number;
  pnlOverride?: number;
  commission?: number;
  result: TradeResult;
  time: string;
  exitTime: string | null;
  duration: number | null;
  durationMinutes?: number | null;
  screenshots: string[];
  scannedImageUrl: string | null;
  emotionalState?: string | null;
  confidenceLevel?: number | null;
  reflection: TradeReflection;
  confluences?: string[];
  behavioralFlags?: string[];
  performanceViolations?: PerformanceViolation[];
  timeframe?: string;
  account: string;
  accountIds?: string[];
  createdAt: string;
}

export interface JournalEntryReflection {
  pre: string;
  post: string;
  lessons: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  trades: Trade[];
  screenshots: string[];
  reflection: JournalEntryReflection;
  rules: Array<{ text: string; state: RuleState }>;
  psychology: {
    setupQuality: number;
    discipline: number;
    execution: number;
  };
  emotions: Array<{ label: string; state: EmotionState }>;
  grade: string;
  /** Legacy single-account field; multi-account entries carry every allocation in accountIds. */
  account: string;
  accountIds?: string[];
  scannedImageUrl?: string;
  dailyReflection?: {
    pre: string;
    post: string;
    lessons: string;
    bias: 'bullish' | 'neutral' | 'bearish' | null;
    newsRisk: 'clear' | 'caution' | 'avoid' | null;
    sessionTarget: number | null;
    sessionGrade: string | null;
    marketRespectedBias: boolean | null;
    lessonCategory: string | null;
  };
  physicalState?: {
    sleep: number;
    sleepHours: number;
    stress: number;
    energy: number;
    distractions: string[];
    environment: string;
  };
  isBlankDay?: boolean;
}

export interface Payout {
  id: string;
  date: string;    // YYYY-MM-DD
  amount: number;  // positive, money taken out
  note?: string;
}

export interface Account {
  id: string;
  name: string;
  firm: string;
  size: number;
  type: 'live' | 'eval' | 'paper';
  phase: 'eval' | 'funded';
  balance: number;
  dailyLossLimit: number;
  maxDrawdown: number;
  profitTarget: number | null;
  startingBalance: number;
  isActive: boolean;
  color?: string;
  payouts?: Payout[];
  evaluationTemplateId?: string;
  minimumTradingDays?: number;
  maxContracts?: number;
  consistencyLimitPct?: number | null;
  drawdownType?: 'static' | 'trailing' | 'eod_trailing' | 'intraday_trailing';
  trailingStopsAt?: number | null;
  evaluationStartedAt?: string;
  firmRuleVersionId?: string;
  evaluationPath?: 'standard' | 'no_activation_fee';
  dailyLossMode?: 'none' | 'purchase_fixed' | 'personal';
  coachingNotes?: string;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  unlockedAt: string | null;
  progress: number;
  condition: string;
}

export interface Goal {
  id: string;
  title: string;
  category: string;
  color: string;
  horizon: string;
  description: string;
  steps: Array<{ id: string; text: string; done: boolean }>;
  status?: 'Active' | 'Paused' | 'Achieved';
  createdAt: string;
  type?: 'financial' | 'discipline' | 'consistency' | 'trade_count' | 'funded';
  target?: number;
}

export interface Setup {
  id: string;
  name: string;
  description: string;
  rank: 'A+' | 'A' | 'B';
  timeframe: string;
  market: string;
  avgRR: string;
  confluences: string[];
  isExpanded?: boolean;
}

export interface RiskRule {
  id: string;
  label: string;
  value: string;
  unit: string;
  color?: 'amber' | 'red' | 'green' | 'cobalt' | 'neutral';
  kind?: 'max_daily_loss' | 'max_trades' | 'max_contracts' | 'min_rr' | 'time_window' | 'cooldown_after_loss' | 'manual';
  enabled?: boolean;
  startTime?: string;
  endTime?: string;
  contractLimits?: Record<string, number>;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done?: boolean;
}

export interface PlanBlock {
  id: string;
  name: string;
  hint: string;
  content: string;
  isOpen?: boolean;
}

export interface PropFirm {
  id: string;
  name: string;
  params: Array<{ id: string; label: string; value: string }>;
}

export type BillingAccountStatus = 'Eval 1' | 'Eval 2' | 'Funded' | 'Passed' | 'Blown' | 'Reset';
export type BillingEvaluationOutcome = 'Unknown' | 'Not passed' | 'Passed' | 'Funded';
export type BillingOutcomeConfidence = 'low' | 'medium' | 'high';

export interface BillingPayout {
  id: string;
  amount: number;
  date: string;
}

export interface BillingAccount {
  id: string;
  sourceAccountId?: string;
  entryKind?: 'account' | 'subscription' | 'reset' | 'activation';
  parentAccountId?: string;
  importedFromFile?: boolean;
  firm: string;
  accountType?: string;
  size: string;
  listPrice: number;
  discountCode: string;
  discountPct: number;
  actualPrice: number;
  purchaseDate: string;
  status: BillingAccountStatus;
  evaluationOutcome?: BillingEvaluationOutcome;
  outcomeEvidence?: string;
  outcomeConfidence?: BillingOutcomeConfidence;
  payoutReceived: number;
  payouts?: BillingPayout[];
  notes?: string;
  roi?: number;
  pricingPath?: 'standard' | 'no_activation_fee';
  activationFee?: number;
  dailyLossMode?: 'none' | 'purchase_fixed';
  optionalDailyLossLimit?: number | null;
  firmRuleVersionId?: string;
  ruleVerifiedAt?: string;
  ruleSourceUrl?: string;
  responsibleTradingDiscount?: number;
  responsibleTradingBenefit?: string;
}

export interface ScannerColors {
  entry: string;
  stopLoss: string;
  takeProfit: string;
}

export interface BacktestSession {
  id: string;
  symbol: string;
  timeframe: string;
  range: string;
  startDate: string;
  endDate: string;
  balance: number;
  openedAt: string;
  isActive: boolean;
}

export interface RivalXpEvent {
  id: string;
  points: number;
  label: string;
  earnedAt: string;
}

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  survey: Record<string, unknown>;
}

export interface PreSessionData {
  emotion: string;
  note: string;
  // Pre-mortem: the trader's own prediction of how today could go wrong,
  // written before the session; post-session compares it to what happened.
  premortem?: string;
  bias: unknown;
  checklistState: unknown;
  startedAt: string | null;
  sessionStartedAt?: string | null;
  endedAt?: string | null;
  postSessionStartedAt?: string | null;
  readiness?: {
    status: 'Ready' | 'Caution' | 'Stand Down';
    score: number;
    summary: string;
    reasons: string[];
  };
  sessionPlan?: Array<{
    id: string;
    source: string;
    rule: string;
  }>;
  prescriptions?: PerformancePrescription[];
  violations?: PerformanceViolation[];
  outcome?: PerformanceOutcome;
  commitment?: {
    committedAt: string;
    emotion: string;
    note: string;
    bias: unknown;
    checklistState: unknown;
    readiness: {
      status: 'Ready' | 'Caution' | 'Stand Down';
      score: number;
      summary: string;
      reasons: string[];
    };
    sessionPlan: Array<{
      id: string;
      source: string;
      rule: string;
    }>;
  };
  sessionMaxLoss?: number | null;
  dailyTarget?: number | null;
  postSessionNote?: string;
}

export type PerformanceRuleType =
  | 'daily_loss_limit'
  | 'max_trades'
  | 'max_contracts'
  | 'post_loss_pause'
  | 'plan_only';

export interface PerformancePrescription {
  id: string;
  type: PerformanceRuleType;
  value: number | boolean;
  label: string;
  reason: string;
  sourcePattern: string;
  createdAt: string;
}

export interface PerformanceViolation {
  id: string;
  ruleId: string;
  type: PerformanceRuleType | 'revenge_trade' | 'plan_deviation';
  severity: 'warning' | 'critical';
  evidence: string;
  cost: number;
  tradeId?: string;
  occurredAt: string;
}

export interface PerformanceOutcome {
  evaluatedAt: string;
  rulesFollowed: number;
  totalRules: number;
  adherencePct: number;
  violations: PerformanceViolation[];
  estimatedCost: number;
  netPnl: number;
}

export interface ChartHistoryRecord {
  sessionId: string;
  symbolDisplay: string;
  widgetSymbol: string;
  timeframe: string;
  accountBalance: number;
  startDate: string;
  endDate: string;
  speed: number;
  createdAt: string;
  lastOpenedAt: string;
}

export interface PrivateLeague {
  id: string;
  name: string;
  memberIds: string[];
}

export interface StoredRival {
  id: string;
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  mascot: {
    stage: string;
    name: string;
    streakDays: number;
    stats: {
      dailyJournalStreak?: number;
      dailyJournalScore?: number;
      tradingJournalScore?: number;
      backtestSessions?: number;
      processScore?: number;
      discipline?: number;
      psychology?: number;
      consistency?: number;
      backtestHours?: number;
    };
    xp: number;
  };
}
