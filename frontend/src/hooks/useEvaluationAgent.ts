import { useEffect, useMemo } from 'react';
import useFlyxaStore from '../store/flyxaStore.js';
import { pushToast } from '../store/toastStore.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  tradesForAccount,
} from '../utils/evaluationCoach.js';

const NOTICE_KEY = 'flyxa-evaluation-agent-notices-v1';

export function useEvaluationAgent() {
  const accounts = useFlyxaStore(state => state.accounts);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const entries = useFlyxaStore(state => state.entries);
  const allTrades = useMemo(() => entries.flatMap(entry => entry.trades), [entries]);
  const account = accounts.find(item => item.id === activeAccountId)
    ?? accounts.find(item => item.type === 'eval' || item.phase === 'eval');

  const alert = useMemo(() => {
    if (!account || (account.type !== 'eval' && account.phase !== 'eval')) return null;
    const accountTrades = tradesForAccount(allTrades, account.id);
    if (!accountTrades.length) return null;
    const progress = computeEvaluationProgress(account, allTrades);
    return buildEvaluationAgentAlerts(account, allTrades, progress)[0] ?? null;
  }, [account, allTrades]);

  useEffect(() => {
    if (!alert || !account) return;
    const today = new Date().toISOString().slice(0, 10);
    const noticeId = `${today}:${account.id}:${alert.id}`;
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(NOTICE_KEY) ?? '[]') as string[];
    } catch {
      seen = [];
    }
    if (seen.includes(noticeId)) return;
    pushToast({
      message: `Evaluation Coach: ${alert.message}`,
      tone: alert.severity === 'critical' ? 'red' : 'amber',
      durationMs: alert.severity === 'critical' ? null : 9000,
    });
    localStorage.setItem(NOTICE_KEY, JSON.stringify([...seen.slice(-40), noticeId]));
  }, [account, alert]);
}
