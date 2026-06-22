export type MascotStage = 'seed' | 'rookie' | 'veteran' | 'elite' | 'apex';
export type LeaderboardPeriod = 'week' | 'month' | 'season' | 'allTime';

export interface RivalPeriodStats {
  netPnl: number;
  winRate: number;
  tradeCount: number;
  tradingDays: number;
  greenDays: number;
  maxDrawdown: number;
  consistency: number;
  ruleAdherence: number;
  riskAdjusted: number;
  equityCurve: number[];
}

export interface MascotStats {
  lifetimeXp?: number;
  dailyJournalStreak: number;
  dailyJournalScore: number;
  tradingJournalScore: number;
  backtestSessions: number;
  processScore: number;
  // Trading performance — only computed for the local user; rivals default to null.
  winRate?: number | null;
  avgR?: number | null;
  netPnl?: number | null;
  periods?: Partial<Record<LeaderboardPeriod, RivalPeriodStats>>;
  previousPeriods?: Partial<Record<Exclude<LeaderboardPeriod, 'allTime'>, RivalPeriodStats>>;
}

export interface Mascot {
  stage: MascotStage;
  name: string;
  streakDays: number;
  stats: MascotStats;
  xp: number;
}

export interface Rival {
  id: string;
  userId?: string;        // Supabase auth UUID — present for backend rivals, absent for local/me
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  mascot: Mascot;
  isMe?: boolean;
}

export type LeaderboardMetric = 'dailyJournal' | 'tradingJournal' | 'backtest' | 'processScore' | 'winRate' | 'avgR' | 'netPnl' | 'consistency' | 'riskAdjusted' | 'journalStreak';
