import { useCallback } from 'react';
import { useBreakingNewsAlert } from './useBreakingNewsAlert.js';
import { pushToast, dismissToast } from '../store/toastStore.js';

/**
 * App-wide breaking-news notification: a red, pulsing toast that stays on
 * screen until the user clicks it. Clicking the body opens the Market News
 * terminal; the × just dismisses. Replaces the old dashboard-only bubble.
 */
export function useBreakingNewsToast() {
  const onAlert = useCallback((headline: { text: string; source: string; timestamp: string }) => {
    const id = pushToast({
      tone: 'red',
      durationMs: null, // persists until the user clicks it
      emphasis: true,
      kicker: `Breaking · ${headline.source}`,
      // The age is rendered live from this stamp so a long-lived toast stays
      // accurate instead of freezing at whatever it said when it appeared.
      timestampMs: new Date(headline.timestamp).getTime(),
      message: headline.text,
      href: '/market-news',
    });
    return () => dismissToast(id);
  }, []);
  useBreakingNewsAlert(onAlert);
}
