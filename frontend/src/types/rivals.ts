export type MascotStage = 'seed' | 'rookie' | 'veteran' | 'elite' | 'apex';

export interface MascotStats {
  dailyJournalStreak: number;
  dailyJournalScore: number;
  tradingJournalScore: number;
  backtestSessions: number;
  processScore: number;
  // Trading performance — only computed for the local user; rivals default to null.
  winRate?: number | null;
  avgR?: number | null;
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
  username: string;
  displayName: string;
  avatarInitials: string;
  avatarColor: string;
  avatarUrl?: string | null;
  mascot: Mascot;
  isMe?: boolean;
}

export type LeaderboardMetric = 'dailyJournal' | 'tradingJournal' | 'backtest' | 'processScore' | 'winRate' | 'avgR';
