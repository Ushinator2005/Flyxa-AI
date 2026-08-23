import { useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { pushToast } from '../store/toastStore.js';
import { recoverMissingTradesFromLocalBackup, recoverMissingBillingFromLocalBackup } from '../utils/browserRecovery.js';

/**
 * Runs browser-backup recovery automatically once per session, after the
 * store has finished hydrating from Supabase (never against an empty store).
 * Silent when there is nothing to recover; green toast when trades were
 * restored. The manual Settings button remains as an explicit fallback.
 */
export function useAutoBrowserRecovery(): void {
  const { user } = useAuth();
  const ranForUser = useRef<string | null>(null);

  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    if (ranForUser.current === userId) return;
    let cancelled = false;

    const run = async () => {
      if (cancelled || ranForUser.current === userId) return;
      ranForUser.current = userId;
      try {
        // Repair a wiped/partial billing ledger from this browser's safe backup.
        const billingRecovered = await recoverMissingBillingFromLocalBackup(userId);
        if (!cancelled && billingRecovered > 0) {
          pushToast({
            message: `Restored ${billingRecovered} billing account${billingRecovered !== 1 ? 's' : ''} from this browser's backup.`,
            tone: 'green',
            durationMs: 6000,
          });
        }

        const { tradesRecovered, daysRecovered } = await recoverMissingTradesFromLocalBackup(userId);
        if (cancelled || (tradesRecovered === 0 && daysRecovered === 0)) return;
        const parts: string[] = [];
        if (tradesRecovered > 0) parts.push(`${tradesRecovered} trade${tradesRecovered !== 1 ? 's' : ''}`);
        if (daysRecovered > 0) parts.push(`${daysRecovered} day${daysRecovered !== 1 ? 's' : ''}`);
        pushToast({
          message: `Restored ${parts.join(' and ')} from this browser's backup.`,
          tone: 'green',
          durationMs: 6000,
        });
      } catch {
        // Auto-recovery is best-effort; the manual Settings button still works.
      }
    };

    if (useFlyxaStore.persist.hasHydrated()) {
      void run();
      return () => { cancelled = true; };
    }
    const unsubscribe = useFlyxaStore.persist.onFinishHydration(() => { void run(); });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [user?.id]);
}
