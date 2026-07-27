import { useEffect, useMemo, useRef } from 'react';
import useFlyxaStore from '../store/flyxaStore.js';
import { useAllTrades, useActiveAccountEntries, useJournalStreak } from '../store/selectors.js';
import { useAuth } from '../contexts/AuthContext.js';
import { supabase } from '../services/api.js';
import type { Goal } from '../types/goals.js';
import type { Goal as StoreGoal } from '../store/types.js';

export type { Goal, GoalStep, GoalStatus } from '../types/goals.js';

type GoalProgressMeta = Goal & {
  type?: 'financial' | 'discipline' | 'consistency' | 'trade_count' | 'funded';
  target?: number;
};

export function useGoalProgress(goal: GoalProgressMeta): number {
  const trades = useAllTrades();
  const entries = useActiveAccountEntries();
  const billingAccounts = useFlyxaStore((state) => state.billingAccounts);
  const journalStreak = useJournalStreak();

  return useMemo(() => {
    const target = goal.target ?? 100;
    if (target <= 0) return 0;

    if (goal.type === 'financial') {
      const totalPnL = trades.reduce((sum, trade) => sum + trade.pnl, 0);
      return Math.min(100, Math.max(0, (totalPnL / target) * 100));
    }

    if (goal.type === 'funded') {
      const passed = billingAccounts.filter((account) => account.status === 'Passed').length;
      return Math.min(100, Math.max(0, (passed / target) * 100));
    }

    if (goal.type === 'discipline') {
      const average = entries.length
        ? entries.reduce((sum, entry) => sum + entry.psychology.discipline, 0) / entries.length
        : 0;
      return Math.min(100, Math.max(0, (average / target) * 100));
    }

    if (goal.type === 'consistency') {
      return Math.min(100, Math.max(0, (journalStreak / target) * 100));
    }

    if (goal.type === 'trade_count') {
      return Math.min(100, Math.max(0, (trades.length / target) * 100));
    }

    const completed = goal.steps.filter((step) => step.done).length;
    return goal.steps.length ? (completed / goal.steps.length) * 100 : 0;
  }, [billingAccounts, entries, goal, journalStreak, trades]);
}

export function useGoals() {
  const { user } = useAuth();
  const goals = useFlyxaStore((state) => state.goals) as Goal[];
  const addGoalToStore = useFlyxaStore((state) => state.addGoal);
  const updateGoalInStore = useFlyxaStore((state) => state.updateGoal);
  const deleteGoalFromStore = useFlyxaStore((state) => state.deleteGoal);
  const hydrateSharedData = useFlyxaStore((state) => state.hydrateSharedData);
  const syncedRef = useRef<string | null>(null);

  // Reset sync flag when user changes so re-login triggers a fresh sync
  useEffect(() => {
    if (user?.id !== syncedRef.current) {
      syncedRef.current = null;
    }
  }, [user?.id]);

  // On login, pull goals from Supabase and merge into local store
  useEffect(() => {
    if (!user || syncedRef.current === user.id) return;
    syncedRef.current = user.id;

    supabase
      .from('goals')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) return;

        const remoteGoals = data.map((row: Record<string, unknown>) => ({
          id: row.id as string,
          title: row.title as string,
          description: (row.description as string) || '',
          category: row.category as Goal['category'],
          color: row.color as Goal['color'],
          horizon: (row.horizon as string) || '',
          steps: (row.steps as Goal['steps']) || [],
          status: (row.status as Goal['status']) || 'Active',
          createdAt: row.created_at as string,
        }));

        // Merge remote goals — remote wins for any ID that exists in both
        const localIds = new Set(goals.map((g) => g.id));
        const newFromRemote = remoteGoals.filter((g) => !localIds.has(g.id));
        const merged = [...remoteGoals, ...goals.filter((g) => !remoteGoals.find((r) => r.id === g.id))];

        if (newFromRemote.length > 0 || merged.length !== goals.length) {
          hydrateSharedData({ goals: merged as unknown as StoreGoal[] });
        }

        // Push any local-only goals up to Supabase
        const remoteIds = new Set(remoteGoals.map((g) => g.id));
        const localOnly = goals.filter((g) => !remoteIds.has(g.id));
        if (localOnly.length > 0) {
          supabase.from('goals').upsert(
            localOnly.map((g) => ({
              id: g.id,
              user_id: user.id,
              title: g.title,
              description: g.description,
              category: g.category,
              color: g.color,
              horizon: g.horizon || null,
              steps: g.steps,
              status: g.status || 'Active',
            }))
          ).then(({ error }) => {
            if (error) console.error('[Goals] Failed to push local goals to Supabase:', error.message);
          });
        }
      });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const addGoal = (goal: Goal) => {
    addGoalToStore(goal as unknown as StoreGoal);
    if (user) {
      supabase.from('goals').insert({
        id: goal.id,
        user_id: user.id,
        title: goal.title,
        description: goal.description,
        category: goal.category,
        color: goal.color,
        horizon: goal.horizon || null,
        steps: goal.steps,
        status: goal.status || 'Active',
      }).then(({ error }) => {
        if (error) console.error('[Goals] Failed to sync new goal to Supabase:', error.message);
      });
    }
  };

  const updateGoal = (goal: Goal) => {
    updateGoalInStore(goal.id, goal as unknown as Partial<StoreGoal>);
    if (user) {
      supabase.from('goals').update({
        title: goal.title,
        description: goal.description,
        category: goal.category,
        color: goal.color,
        horizon: goal.horizon || null,
        steps: goal.steps,
        status: goal.status || 'Active',
        updated_at: new Date().toISOString(),
      }).eq('id', goal.id).eq('user_id', user.id).then(({ error }) => {
        if (error) console.error('[Goals] Failed to sync goal update to Supabase:', error.message);
      });
    }
  };

  const deleteGoal = (goalId: string) => {
    deleteGoalFromStore(goalId);
    if (user) {
      supabase.from('goals').delete()
        .eq('id', goalId).eq('user_id', user.id)
        .then(({ error }) => {
          if (error) console.error('[Goals] Failed to delete goal from Supabase:', error.message);
        });
    }
  };

  const toggleStep = (goalId: string, stepId: string) => {
    const goal = useFlyxaStore.getState().goals.find((item) => item.id === goalId);
    if (!goal) return;

    const updatedSteps = goal.steps.map((step) => (
      step.id === stepId ? { ...step, done: !step.done } : step
    ));

    updateGoalInStore(goalId, { steps: updatedSteps });

    if (user) {
      supabase.from('goals').update({
        steps: updatedSteps,
        updated_at: new Date().toISOString(),
      }).eq('id', goalId).eq('user_id', user.id).then(({ error }) => {
        if (error) console.error('[Goals] Failed to sync step toggle to Supabase:', error.message);
      });
    }
  };

  return {
    goals,
    loading: false,
    error: null,
    addGoal,
    updateGoal,
    deleteGoal,
    toggleStep,
  };
}
