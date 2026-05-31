export type TradeDirection = 'LONG' | 'SHORT';
export type TradeResult = 'win' | 'loss' | 'open';
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
  timeframe?: string;
  account: string;
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
  account: string;
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

export interface BillingPayout {
  id: string;
  amount: number;
  date: string;
}

export interface BillingAccount {
  id: string;
  firm: string;
  size: string;
  listPrice: number;
  discountCode: string;
  discountPct: number;
  actualPrice: number;
  purchaseDate: string;
  status: BillingAccountStatus;
  payoutReceived: number;
  payouts?: BillingPayout[];
  notes?: string;
  roi?: number;
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

export interface OnboardingState {
  completed: boolean;
  completedAt?: string;
  survey: Record<string, unknown>;
}

export interface PreSessionData {
  emotion: string;
  note: string;
  bias: unknown;
  checklistState: unknown;
  startedAt: string | null;
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
