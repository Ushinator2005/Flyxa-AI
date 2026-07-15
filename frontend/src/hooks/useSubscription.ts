import { useCallback, useEffect, useState } from 'react';
import { subscriptionApi, type SubscriptionStatusResponse } from '../services/api.js';

// Subscription state for gating and the Upgrade page. While loading (or if the
// backend has no Stripe keys configured) the account is treated as active so
// the app never locks out a paying user over a transient error, and dev works
// without any billing setup.
export function useSubscription() {
  const [status, setStatus] = useState<SubscriptionStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await subscriptionApi.getStatus();
      setStatus(next);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    loading,
    configured: status?.configured ?? false,
    active: status ? status.active : true,
    status: status?.status ?? 'unknown',
    currentPeriodEnd: status?.currentPeriodEnd ?? null,
    hasCustomer: status?.hasCustomer ?? false,
    refresh,
  };
}
