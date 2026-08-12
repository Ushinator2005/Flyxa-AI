import { useEffect, useMemo, useState } from 'react';
import { useActiveAccountEntries } from '../store/selectors.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { journalApi, rivalsApi } from '../services/api.js';
import type { JournalEntry as DailyJournalEntry } from '../types/index.js';
import type { BacktestSession } from '../store/types.js';
import { averageRR } from '../utils/riskReward.js';
import {
  computeDailyJournalStreak, computeDailyJournalScore,
  computeTradingJournalScore, computeRuleFollowingScore, computeProcessScore,
  buildLifetimeXpEvents, periodBounds, computePeriodStats, periodRuleAdherence,
} from '../utils/rivalStatsCompute.js';

export function useRivalStatsSync() {
  const entries = useActiveAccountEntries();
  const backtestSessions = useFlyxaStore(state => state.backtestSessions) as BacktestSession[];
  const riskRules = useFlyxaStore(state => state.riskRules);
  const rivalXpEvents = useFlyxaStore(state => state.rivalXpEvents);
  const mergeRivalXpEvents = useFlyxaStore(state => state.mergeRivalXpEvents);
  const [dailyJournalEntries, setDailyJournalEntries] = useState<DailyJournalEntry[]>([]);
  const [hasProfile, setHasProfile] = useState(false);
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      journalApi.getAll().catch(() => []),
      rivalsApi.getProfile().catch(() => null),
    ]).then(([journal, profile]) => {
      if (cancelled) return;
      setDailyJournalEntries(journal as DailyJournalEntry[]);
      setHasProfile(Boolean(profile));
      setProfileAvatarUrl(profile?.avatarUrl ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  const earnedXpEvents = useMemo(
    () => buildLifetimeXpEvents(dailyJournalEntries, entries, backtestSessions, computeDailyJournalStreak(dailyJournalEntries), riskRules),
    [backtestSessions, dailyJournalEntries, entries, riskRules]
  );

  useEffect(() => {
    mergeRivalXpEvents(earnedXpEvents);
  }, [earnedXpEvents, mergeRivalXpEvents]);

  const statsSignature = useMemo(() => {
    const dailyJournalStreak = computeDailyJournalStreak(dailyJournalEntries);
    const tradingJournalScore = computeTradingJournalScore(entries);
    const ruleFollowing = computeRuleFollowingScore(entries, entries.flatMap(e => e.trades), riskRules);
    const allSavedTrades = entries.flatMap(e => e.trades);
    const allTrades = allSavedTrades.filter(t => t.result === 'win' || t.result === 'loss');
    const winRate = allTrades.length > 0 ? Math.round((allTrades.filter(t => t.result === 'win').length / allTrades.length) * 100) : null;
    const avgR = averageRR(allTrades);
    const tradeSignature = allSavedTrades
      .map(t => [
        t.id,
        t.date,
        t.time,
        t.pnl,
        t.commission ?? 0,
        t.result,
        t.rr,
        t.contracts,
        t.reflection?.followedPlan,
      ].join(':'))
      .sort()
      .join('|');
    return JSON.stringify({ dailyJournalStreak, tradingJournalScore, ruleFollowing, winRate, avgR, tradeSignature });
  }, [dailyJournalEntries, entries, riskRules]);

  useEffect(() => {
    if (!hasProfile) return;

    const dailyJournalStreak = computeDailyJournalStreak(dailyJournalEntries);
    const tradingJournalScore = computeTradingJournalScore(entries);
    const ruleFollowing = computeRuleFollowingScore(entries, entries.flatMap(e => e.trades), riskRules);
    const processScore = computeProcessScore(dailyJournalEntries, dailyJournalStreak, tradingJournalScore, ruleFollowing);
    const dailyJournalScore = computeDailyJournalScore(dailyJournalEntries, dailyJournalStreak);

    const allTrades = entries.flatMap(e => e.trades).filter(t => t.result === 'win' || t.result === 'loss');
    const winRate = allTrades.length > 0 ? Math.round((allTrades.filter(t => t.result === 'win').length / allTrades.length) * 100) : null;
    const avgR = averageRR(allTrades);
    const allSavedTrades = entries.flatMap(e => e.trades);
    const netPnl = Math.round(allSavedTrades.reduce((sum, t) => sum + t.pnl - (t.commission ?? 0), 0) * 100) / 100;

    const merged = { ...rivalXpEvents };
    for (const event of earnedXpEvents) merged[event.id] ??= event;
    const lifetimeXp = Object.values(merged).reduce((sum, event) => sum + event.points, 0);

    const dayBounds = periodBounds('day');
    const weekBounds = periodBounds('week');
    const monthBounds = periodBounds('month');
    const quarterBounds = periodBounds('quarter');
    const yearBounds = periodBounds('year');
    const localPeriods = {
      allTime: { ...computePeriodStats(allSavedTrades), ruleAdherence: periodRuleAdherence(entries, riskRules) },
      day: { ...computePeriodStats(allSavedTrades, dayBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, dayBounds) },
      week: { ...computePeriodStats(allSavedTrades, weekBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, weekBounds) },
      month: { ...computePeriodStats(allSavedTrades, monthBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, monthBounds) },
      quarter: { ...computePeriodStats(allSavedTrades, quarterBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, quarterBounds) },
      year: { ...computePeriodStats(allSavedTrades, yearBounds), ruleAdherence: periodRuleAdherence(entries, riskRules, yearBounds) },
    };
    const localPreviousPeriods = {
      day: computePeriodStats(allSavedTrades, periodBounds('day', true)),
      week: computePeriodStats(allSavedTrades, periodBounds('week', true)),
      month: computePeriodStats(allSavedTrades, periodBounds('month', true)),
      quarter: computePeriodStats(allSavedTrades, periodBounds('quarter', true)),
      year: computePeriodStats(allSavedTrades, periodBounds('year', true)),
    };
    const periods = localPeriods;
    const previousPeriods = localPreviousPeriods;

    rivalsApi.updateStats({
      lifetimeXp,
      dailyJournalStreak,
      dailyJournalScore,
      tradingJournalScore,
      backtestSessions: backtestSessions.length,
      processScore,
      winRate,
      avgR,
      netPnl: localPeriods.allTime.netPnl ?? netPnl,
      periods,
      previousPeriods,
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasProfile, statsSignature]);

  return { profileAvatarUrl };
}
