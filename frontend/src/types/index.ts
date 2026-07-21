export interface Trade {
  id: string;
  user_id: string;
  symbol: string;
  screenshot_url?: string;
  accountId?: string;
  account_id?: string;
  accountIds?: string[];
  account_ids?: string[];
  direction: 'Long' | 'Short';
  entry_price: number;
  exit_price: number;
  sl_price: number;
  tp_price: number;
  exit_reason: 'TP' | 'SL' | 'BE';
  pnl: number;
  pnlOverride?: number;
  commission?: number;
  contract_size: number;
  point_value: number;
  trade_date: string;
  trade_time: string;
  close_time?: string | null;
  trade_length_seconds: number;
  candle_count: number;
  timeframe_minutes: number;
  emotional_state?: string | null;
  confidence_level?: number | null;
  preEntry?: {
    confidenceAtEntry?: number;
    emotionalState?: string;
    hesitated?: boolean | null;
    hesitationReason?: string;
  };
  thesis?: {
    setup?: string;
    invalidation?: string;
    asymmetry?: string;
    setupType?: string;
  };
  executionReview?: {
    enteredAtLevel?: boolean | null;
    waitedForConfirmation?: boolean | null;
    correctSize?: boolean | null;
    exitedAtPlan?: boolean | null;
    movedStopCorrectly?: boolean | null;
    resistedEarlyExit?: boolean | null;
    note?: string;
  };
  psychologyRatings?: {
    setupQuality?: number;
    discipline?: number;
    execution?: number;
    patience?: number;
    riskManagement?: number;
    emotionalControl?: number;
    notes?: Record<string, string>;
  };
  stateOfMind?: Array<{ label: string; valence: 'positive' | 'caution' | 'negative' }>;
  processScore?: number;
  sessionContext?: {
    emotion?: string;
    note?: string;
    bias?: Record<string, string>;
    readiness?: {
      status?: string;
      score?: number;
      summary?: string;
      reasons?: string[];
    };
    sessionPlan?: Array<{ id?: string; source?: string; rule?: string }>;
    dailyReflection?: {
      pre?: string;
      bias?: string | null;
      newsRisk?: string | null;
      sessionTarget?: number | null;
      marketRespectedBias?: boolean | null;
    };
  };
  pre_trade_notes: string;
  post_trade_notes: string;
  confluences?: string[];
  followed_plan?: boolean | null;
  plan_score?: number | null;
  behavioral_flags?: string[];
  performance_violations?: import('../store/types.js').PerformanceViolation[];
  session: 'Asia' | 'London' | 'Pre Market' | 'New York' | 'Other';
  created_at: string;
}

export interface PsychologyLog {
  id: string;
  user_id: string;
  date: string;
  mood: string;
  pre_session_notes: string;
  post_session_notes: string;
  mindset_score: number;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  user_id: string;
  date: string;
  content: string;
  screenshots: string[];
  mood?: string | null;
  created_at: string;
}

export interface JournalBackupPayload {
  version: number;
  exported_at: string;
  user_id: string | null;
  entries: Array<Pick<JournalEntry, 'date' | 'content' | 'screenshots' | 'mood'>>;
  moods: Record<string, string>;
  titles: Record<string, string>;
}

export interface JournalBackupRestoreResult {
  requested: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface RiskSettings {
  id: string;
  user_id: string;
  daily_loss_limit: number;
  max_trades_per_day: number;
  max_contracts_per_trade: number;
  account_size: number;
  risk_percentage: number;
  updated_at: string;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

export interface AnalyticsSummary {
  netPnL: number;
  winRate: number;
  profitFactor: number;
  avgRR: number;
  totalTrades: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
}

export interface DailyPnLPoint {
  date: string;
  pnl: number;
}

export interface EquityCurvePoint {
  date: string;
  pnl: number;
  cumulative: number;
}

export interface SessionData {
  session: string;
  trades: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
}

export interface InstrumentData {
  symbol: string;
  trades: number;
  winRate: number;
  netPnL: number;
  profitFactor: number;
}

export interface DayOfWeekData {
  day: string;
  trades: number;
  winRate: number;
  avgPnL: number;
  netPnL: number;
}

export interface DailyStatus {
  date: string;
  todayPnL: number;
  tradesCount: number;
  maxTradesPerDay: number;
  dailyLossLimit: number;
  lossUsedPercent: number;
  isLocked: boolean;
  todayTrades: Trade[];
  settings: RiskSettings;
}

export interface ExtractedTradeData {
  symbol: string | null;
  direction: 'Long' | 'Short' | null;
  entry_price: number | null;
  entry_time: string | null;
  close_time?: string | null;
  entry_time_confidence: 'high' | 'medium' | 'low' | null;
  sl_price: number | null;
  tp_price: number | null;
  trade_length_seconds: number | null;
  candle_count: number | null;
  timeframe_minutes: number | null;
  exit_reason: 'TP' | 'SL' | null;
  pnl_result: 'Win' | 'Loss' | null;
  exit_confidence: 'high' | 'medium' | 'low' | null;
  first_touch_candle_index: number | null;
  first_touch_evidence: string | null;
  warnings?: string[];
  scanner_debug?: {
    direction_hint?: 'Long' | 'Short';
    entry_line_ratio?: number;
    stop_line_ratio?: number;
    target_line_ratio?: number;
    box_left_ratio?: number;
    box_right_ratio?: number;
    used_dynamic_crops: boolean;
  };
}

export type TradingAccountType = 'Futures' | 'Forex' | 'Stocks';
export type TradingAccountStatus = 'Eval' | 'Funded' | 'Live' | 'Passed' | 'Blown';

export interface TradingAccount {
  id: string;
  name: string;
  broker?: string;
  type: TradingAccountType;
  status: TradingAccountStatus;
  color: string;
  createdAt: string;
  startingBalance?: number;
  targetBalance?: number;
  archived?: boolean;
  isDefault?: boolean;
  firmRuleVersionId?: string;
  evaluationProgram?: string;
  evaluationPath?: 'standard' | 'no_activation_fee';
  dailyLossMode?: 'none' | 'purchase_fixed' | 'personal';
  dailyLossLimit?: number;
  maxDrawdown?: number;
  profitTarget?: number | null;
  minimumTradingDays?: number;
  maxContracts?: number;
  maxMicros?: number;
  consistencyLimitPct?: number | null;
  drawdownType?: 'static' | 'trailing';
  ruleVerifiedAt?: string;
  ruleSourceUrl?: string;
}

export interface AppPreferences {
  dateFormat: 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd';
  currencySymbol: '$' | '€' | '£' | 'A$';
  timezone: string;
  defaultTimeframe: '1m' | '5m' | '15m' | '1h';
  defaultChartType: 'Candles' | 'Line' | 'Area';
  sessionTimes: {
    asia: {
      start: string;
      end: string;
    };
    london: {
      start: string;
      end: string;
    };
    preMarket: {
      start: string;
      end: string;
    };
    newYork: {
      start: string;
      end: string;
    };
  };
  scannerColors: {
    entry: string;
    stopLoss: string;
    takeProfit: string;
  };
  // Which market's hours drive the header clock and pre-session timing.
  marketClock?: 'equities' | 'futures' | 'forex';
}
