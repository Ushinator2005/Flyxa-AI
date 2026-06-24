import { useEffect, useMemo, useState } from 'react';
import type { LeaderboardPeriod, Rival, RivalPeriodStats } from '../types/rivals.js';
import { getMascotStage } from '../lib/mascotProgression.js';
import { useActiveAccountEntries } from '../store/selectors.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { journalApi, rivalsApi, type RivalProfileResponse, type RivalRequestResponse } from '../services/api.js';
import type { BacktestSession, JournalEntry as TradingJournalEntry, RivalXpEvent, Trade } from '../store/types.js';
import type { JournalEntry as DailyJournalEntry } from '../types/index.js';
import type { MascotStats } from '../types/rivals.js';
import {
  computeDailyJournalStreak, computeDailyJournalScore,
  computeTradingJournalScore, computeRuleFollowingScore, computeProcessScore,
  buildLifetimeXpEvents, periodBounds, computePeriodStats, periodRuleAdherence,
} from '../utils/rivalStatsCompute.js';

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
  const lifetimeXp = typeof raw.lifetimeXp === 'number' && Number.isFinite(raw.lifetimeXp)
    ? Math.max(0, Math.round(raw.lifetimeXp))
    : undefined;
  return {
    ...rival,
    mascot: {
      ...rival.mascot,
      streakDays: dailyJournalStreak,
      stats: {
        ...(lifetimeXp !== undefined ? { lifetimeXp } : {}),
        dailyJournalStreak,
        dailyJournalScore,
        tradingJournalScore,
        backtestSessions,
        processScore,
        winRate: raw.winRate ?? null,
        avgR: raw.avgR ?? null,
        netPnl: raw.netPnl ?? null,
        periods: raw.periods ?? {},
        previousPeriods: raw.previousPeriods ?? {},
      },
    },
  };
}

function rivalFromRequest(request: RivalRequestResponse): Rival | null {
  if (request.status !== 'accepted' || !request.profile) return null;
  const profile = request.profile;
  const stats = profile.stats ?? { dailyJournalStreak: 0, dailyJournalScore: 0, tradingJournalScore: 0, backtestSessions: 0, processScore: 0, winRate: null, avgR: null, netPnl: null };
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
  const riskRules = useFlyxaStore(state => state.riskRules);
  const rivalXpEvents = useFlyxaStore(state => state.rivalXpEvents);
  const mergeRivalXpEvents = useFlyxaStore(state => state.mergeRivalXpEvents);
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

  const dailyJournalStreak = useMemo(
    () => computeDailyJournalStreak(dailyJournalEntries),
    [dailyJournalEntries]
  );
  const earnedXpEvents = useMemo(
    () => buildLifetimeXpEvents(dailyJournalEntries, entries, backtestSessions, dailyJournalStreak),
    [backtestSessions, dailyJournalEntries, dailyJournalStreak, entries]
  );
  const lifetimeXp = useMemo(() => {
    const merged = { ...rivalXpEvents };
    for (const event of earnedXpEvents) merged[event.id] ??= event;
    return Object.values(merged).reduce((sum, event) => sum + event.points, 0);
  }, [earnedXpEvents, rivalXpEvents]);

  useEffect(() => {
    mergeRivalXpEvents(earnedXpEvents);
  }, [earnedXpEvents, mergeRivalXpEvents]);

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
    const dailyJournalScore = computeDailyJournalScore(dailyJournalEntries, dailyJournalStreak);
    const tradingJournalScore = computeTradingJournalScore(entries);
    const ruleFollowing = computeRuleFollowingScore(entries, entries.flatMap(entry => entry.trades), riskRules);
    const processScore = computeProcessScore(dailyJournalEntries, dailyJournalStreak, tradingJournalScore, ruleFollowing);

    const allTrades = entries.flatMap(entry => entry.trades).filter(t => t.result === 'win' || t.result === 'loss');
    const winTrades = allTrades.filter(t => t.result === 'win');
    const lossTrades = allTrades.filter(t => t.result === 'loss');
    const winRate = allTrades.length > 0 ? Math.round((winTrades.length / allTrades.length) * 100) : null;
    const tradesWithRR = allTrades.filter(t => typeof t.rr === 'number' && isFinite(t.rr) && t.rr !== 0);
    const avgR = tradesWithRR.length > 0
      ? Math.round((tradesWithRR.reduce((sum, t) => sum + t.rr, 0) / tradesWithRR.length) * 100) / 100
      : null;
    const netPnl = Math.round(
      entries.flatMap(entry => entry.trades)
        .reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0) * 100
    ) / 100;
    const allSavedTrades = entries.flatMap(entry => entry.trades);
    const weekBounds = periodBounds('week');
    const monthBounds = periodBounds('month');
    const seasonBounds = periodBounds('season');
    const localPeriods = {
      allTime: { ...computePeriodStats(allSavedTrades), ruleAdherence: periodRuleAdherence(entries, riskRules) },
      week: { ...computePeriodStats(allSavedTrades, weekBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, weekBounds) },
      month: { ...computePeriodStats(allSavedTrades, monthBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, monthBounds) },
      season: { ...computePeriodStats(allSavedTrades, seasonBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, seasonBounds) },
    };
    const localPreviousPeriods = {
      week: computePeriodStats(allSavedTrades, periodBounds('week', true)),
      month: computePeriodStats(allSavedTrades, periodBounds('month', true)),
      season: computePeriodStats(allSavedTrades, periodBounds('season', true)),
    };
    // Local computation always wins — backend is a mirror for others to read.
    // Spreading local LAST ensures stale backend values never override fresh local data.
    const periods = { ...(profile?.stats?.periods ?? {}), ...localPeriods };
    const previousPeriods = { ...(profile?.stats?.previousPeriods ?? {}), ...localPreviousPeriods };

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
          lifetimeXp,
          dailyJournalStreak,
          dailyJournalScore,
          tradingJournalScore,
          backtestSessions: backtestSessions.length,
          processScore,
          winRate,
          avgR,
          netPnl: periods.allTime.netPnl ?? netPnl,
          periods,
          previousPeriods,
        },
        xp: 0,
      },
    };

    me.mascot.xp = lifetimeXp;
    return me;
  }, [backtestSessions.length, dailyJournalEntries, dailyJournalStreak, entries, lifetimeXp, profile?.avatarUrl, profile?.stats, riskRules]);

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
