import { useEffect, useMemo, useState } from 'react';
import type { Rival } from '../types/rivals.js';
import { getMascotStage, getMascotXP } from '../lib/mascotProgression.js';
import { useActiveAccountEntries } from '../store/selectors.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { journalApi, rivalsApi, type RivalProfileResponse, type RivalRequestResponse } from '../services/api.js';
import type { BacktestSession, JournalEntry as TradingJournalEntry, Trade } from '../store/types.js';
import type { JournalEntry as DailyJournalEntry } from '../types/index.js';
import type { MascotStats } from '../types/rivals.js';

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return isoDate(date);
}

function isMeaningfulTradingJournalEntry(entry: TradingJournalEntry): boolean {
  const hasReflection = Boolean(
    entry.reflection.pre.trim() ||
    entry.reflection.post.trim() ||
    entry.reflection.lessons.trim() ||
    entry.dailyReflection?.pre?.trim() ||
    entry.dailyReflection?.post?.trim() ||
    entry.dailyReflection?.lessons?.trim()
  );
  const hasPsychology = entry.psychology.setupQuality > 0 || entry.psychology.discipline > 0 || entry.psychology.execution > 0;
  return hasReflection || hasPsychology || entry.rules.length > 0 || entry.trades.length > 0;
}

function isMeaningfulDailyJournalEntry(entry: DailyJournalEntry): boolean {
  return Boolean(entry.content?.trim() || (entry.screenshots ?? []).length > 0);
}

function computeDailyJournalStreak(entries: DailyJournalEntry[]): number {
  const journalDates = new Set(
    entries
      .filter(isMeaningfulDailyJournalEntry)
      .map(entry => entry.date)
  );
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (!journalDates.has(isoDate(start))) start.setDate(start.getDate() - 1);

  let streak = 0;
  for (let i = 0; i < 366; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() - i);
    if (!journalDates.has(isoDate(date))) break;
    streak += 1;
  }

  return streak;
}

function computeDailyJournalCoverage(entries: DailyJournalEntry[]): number {
  const journalDates = new Set(
    entries
      .filter(entry => entry.date >= daysAgo(29) && isMeaningfulDailyJournalEntry(entry))
      .map(entry => entry.date)
  );
  return clampScore((journalDates.size / 30) * 100);
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function recentWeekdayDates(count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  while (dates.length < count) {
    if (isWeekday(cursor)) dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates;
}

function computeTradingJournalScore(entries: TradingJournalEntry[]): number {
  const entryDates = new Set(
    entries
      .filter(entry => isMeaningfulTradingJournalEntry(entry) && entry.trades.length > 0)
      .map(entry => entry.date)
  );
  const weekdays = recentWeekdayDates(20);
  const covered = weekdays.filter(date => entryDates.has(date)).length;
  return clampScore((covered / weekdays.length) * 100);
}

function computeRuleFollowingScore(entries: TradingJournalEntry[], trades: Trade[]): number {
  const last30 = entries.filter(entry => entry.date >= daysAgo(29));
  const recentTrades = trades.filter(trade => trade.date >= daysAgo(29));
  const planLogged = recentTrades.filter(trade => typeof trade.reflection?.followedPlan === 'boolean');
  const planAdherence = planLogged.length > 0
    ? (planLogged.filter(trade => trade.reflection.followedPlan === true).length / planLogged.length) * 100
    : null;
  const planCoverage = recentTrades.length > 0 ? (planLogged.length / recentTrades.length) * 100 : null;
  const tradePlanScore = planAdherence === null
    ? null
    : (planAdherence * 0.75) + ((planCoverage ?? 0) * 0.25);

  const evaluatedRules = last30.flatMap(entry => entry.rules.filter(rule => rule.state !== 'unchecked'));
  const rulePassScore = evaluatedRules.length > 0
    ? (evaluatedRules.filter(rule => rule.state === 'ok').length / evaluatedRules.length) * 100
    : null;

  const scores = [tradePlanScore, rulePassScore].filter((score): score is number => typeof score === 'number');
  return clampScore(mean(scores));
}

function computeDailyJournalScore(entries: DailyJournalEntry[], dailyJournalStreak: number): number {
  const coverageScore = computeDailyJournalCoverage(entries);
  const streakBonusScore = clampScore((dailyJournalStreak / 14) * 100);
  return clampScore((coverageScore * 0.7) + (streakBonusScore * 0.3));
}

function computeProcessScore(entries: DailyJournalEntry[], dailyJournalStreak: number, tradingJournalScore: number, ruleFollowingScore: number): number {
  const dailyJournalScore = computeDailyJournalScore(entries, dailyJournalStreak);
  return clampScore(
    (dailyJournalScore * 0.4) +
    (tradingJournalScore * 0.35) +
    (ruleFollowingScore * 0.25)
  );
}

function normalizeRivalStats(rival: Rival): Rival {
  const raw = rival.mascot.stats as MascotStats & {
    discipline?: number;
    psychology?: number;
    consistency?: number;
    backtestHours?: number;
  };
  const dailyJournalStreak = raw.dailyJournalStreak ?? rival.mascot.streakDays ?? 0;
  const dailyJournalScore = raw.dailyJournalScore ?? dailyJournalStreak;
  const tradingJournalScore = raw.tradingJournalScore ?? raw.discipline ?? 0;
  const backtestSessions = raw.backtestSessions ?? raw.backtestHours ?? 0;
  const processScore = raw.processScore ?? raw.consistency ?? raw.psychology ?? 0;
  return {
    ...rival,
    mascot: {
      ...rival.mascot,
      streakDays: dailyJournalStreak,
      stats: {
        dailyJournalStreak,
        dailyJournalScore,
        tradingJournalScore,
        backtestSessions,
        processScore,
        winRate: raw.winRate ?? null,
        avgR: raw.avgR ?? null,
      },
    },
  };
}

function rivalFromRequest(request: RivalRequestResponse): Rival | null {
  if (request.status !== 'accepted' || !request.profile) return null;
  const profile = request.profile;
  const stats = profile.stats ?? { dailyJournalStreak: 0, dailyJournalScore: 0, tradingJournalScore: 0, backtestSessions: 0, processScore: 0, winRate: null, avgR: null };
  return normalizeRivalStats({
    id: `rival-user-${profile.userId}`,
    userId: profile.userId,
    username: profile.username,
    displayName: profile.displayName,
    avatarInitials: profile.avatarInitials,
    avatarColor: profile.avatarColor,
    avatarUrl: profile.avatarUrl ?? null,
    mascot: {
      stage: getMascotStage(stats.processScore),
      name: profile.displayName,
      streakDays: stats.dailyJournalStreak,
      stats,
      xp: 0,
    },
  });
}

export function useRivals() {
  const storedRivals = useFlyxaStore(state => state.rivals) as Rival[];
  const setRivalsAction = useFlyxaStore(state => state.setRivals);
  const entries = useActiveAccountEntries();
  const backtestSessions = useFlyxaStore(state => state.backtestSessions) as BacktestSession[];
  const [dailyJournalEntries, setDailyJournalEntries] = useState<DailyJournalEntry[]>([]);
  const [rivalRequests, setRivalRequests] = useState<RivalRequestResponse[]>([]);
  const [profile, setProfile] = useState<RivalProfileResponse | null>(null);
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    journalApi.getAll()
      .then((data) => {
        if (!cancelled) setDailyJournalEntries(data as DailyJournalEntry[]);
      })
      .catch(() => {
        if (!cancelled) setDailyJournalEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-fetch profile whenever UsernamePrompt saves a new username
  useEffect(() => {
    const handler = () => setProfileVersion(v => v + 1);
    window.addEventListener('flyxa:profile-saved', handler);
    return () => window.removeEventListener('flyxa:profile-saved', handler);
  }, []);

  const resolvedRivals = storedRivals
    .filter((rival) => !rival.isMe)
    .map(normalizeRivalStats) as Rival[];

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      rivalsApi.getProfile().catch(() => null),
      rivalsApi.getAll().catch(() => []),
    ]).then(([profileData, requestsData]) => {
      if (cancelled) return;
      setProfile(profileData);
      setRivalRequests(requestsData ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [profileVersion]);

  // Poll every 20s so both sides see friend request changes without refreshing
  useEffect(() => {
    const id = window.setInterval(() => {
      rivalsApi.getAll().then(setRivalRequests).catch(() => {});
    }, 20_000);
    return () => window.clearInterval(id);
  }, []);

  // Also refresh immediately when the user returns to this tab
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        rivalsApi.getAll().then(setRivalRequests).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const backendRivals = useMemo(
    () => rivalRequests.map(rivalFromRequest).filter((rival): rival is Rival => Boolean(rival)),
    [rivalRequests]
  );

  const saveProfile = async (data: { username: string; displayName?: string; avatarColor?: string; avatarUrl?: string | null }) => {
    const next = await rivalsApi.updateProfile(data);
    setProfile(next);
  };

  const respondToRequest = async (id: string, action: 'accept' | 'decline' | 'cancel') => {
    await rivalsApi.updateRequest(id, action);
    const requests = await rivalsApi.getAll();
    setRivalRequests(requests);
  };

  const myRival = useMemo(() => {
    const dailyJournalStreak = computeDailyJournalStreak(dailyJournalEntries);
    const dailyJournalScore = computeDailyJournalScore(dailyJournalEntries, dailyJournalStreak);
    const tradingJournalScore = computeTradingJournalScore(entries);
    const ruleFollowing = computeRuleFollowingScore(entries, entries.flatMap(entry => entry.trades));
    const processScore = computeProcessScore(dailyJournalEntries, dailyJournalStreak, tradingJournalScore, ruleFollowing);

    const allTrades = entries.flatMap(entry => entry.trades).filter(t => t.result === 'win' || t.result === 'loss');
    const winTrades = allTrades.filter(t => t.result === 'win');
    const lossTrades = allTrades.filter(t => t.result === 'loss');
    const winRate = allTrades.length > 0 ? Math.round((winTrades.length / allTrades.length) * 100) : null;
    // Avg R: winning trades contribute their rr, losing trades cost 1R.
    const avgR = allTrades.length > 0
      ? Math.round(((winTrades.reduce((sum, t) => sum + t.rr, 0) - lossTrades.length) / allTrades.length) * 100) / 100
      : null;

    const me: Rival = {
      id: 'rival-me',
      username: 'you',
      displayName: 'You',
      avatarInitials: 'YU',
      avatarColor: '#f59e0b',
      avatarUrl: profile?.avatarUrl ?? null,
      isMe: true,
      mascot: {
        stage: getMascotStage(processScore),
        name: 'You',
        streakDays: dailyJournalStreak,
        stats: {
          dailyJournalStreak,
          dailyJournalScore,
          tradingJournalScore,
          backtestSessions: backtestSessions.length,
          processScore,
          winRate,
          avgR,
        },
        xp: 0,
      },
    };

    me.mascot.xp = getMascotXP(me.mascot.streakDays, me.mascot.stats);
    return me;
  }, [backtestSessions.length, dailyJournalEntries, entries, profile?.avatarUrl]);

  const myStatsSignature = useMemo(() => JSON.stringify(myRival.mascot.stats), [myRival.mascot.stats]);

  useEffect(() => {
    if (!profile) return;
    rivalsApi.updateStats(myRival.mascot.stats).catch(() => {
      // Rival stats are public leaderboard metadata. The page still works if sync fails.
    });
  }, [myStatsSignature, myRival.mascot.stats, profile]);

  const rivals = useMemo(() => {
    const remoteIds = new Set(backendRivals.map(rival => rival.username.toLowerCase()));
    const localOnly = resolvedRivals.filter((rival) => !rival.isMe && !remoteIds.has(rival.username.toLowerCase()));
    return [myRival, ...backendRivals, ...localOnly];
  }, [backendRivals, myRival, resolvedRivals]);

  const addRival = async (username: string) => {
    const cleaned = username.trim().replace(/^@/, '');
    if (!cleaned) return;

    const request = await rivalsApi.sendRequest(cleaned);
    setRivalRequests(current => [request, ...current.filter(item => item.id !== request.id)]);
  };

  const removeRival = (id: string) => {
    setRivalsAction(resolvedRivals.filter((rival) => rival.id !== id) as typeof resolvedRivals);
  };

  return { rivals, addRival, removeRival, rivalRequests, profile, saveProfile, respondToRequest };
}
