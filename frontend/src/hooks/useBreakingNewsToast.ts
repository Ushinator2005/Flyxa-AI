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
    const ageMins = Math.round((Date.now() - new Date(headline.timestamp).getTime()) / 60_000);
    const ageLabel = ageMins < 1 ? 'just now' : ageMins === 1 ? '1 min ago' : `${ageMins} min ago`;
    const id = pushToast({
      tone: 'red',
      durationMs: null, // persists until the user clicks it
      emphasis: true,
      kicker: `Breaking · ${headline.source} · ${ageLabel}`,
      message: headline.text,
      href: '/market-news',
    });
    return () => dismissToast(id);
  }, []);
  useBreakingNewsAlert(onAlert);
}
