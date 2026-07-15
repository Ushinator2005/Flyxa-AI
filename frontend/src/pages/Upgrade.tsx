import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { subscriptionApi } from '../services/api.js';
import { useSubscription } from '../hooks/useSubscription.js';
import { C } from '../utils/theme.js';

const FEATURES = [
  ['AI chart scanner', 'Screenshot in, verified entry/stop/target/exit out.'],
  ['Session psychology', 'Pre-session readiness, live session view, post-session grading.'],
  ['The rulebook', 'Your limits, enforced across pre-session, live warnings, and journal verification.'],
  ['AI coaching', 'Weekly debriefs, pattern library, and Ask Flyxa over your own data.'],
  ['Evaluation coach', 'Prop-firm progress, pass probability, and drawdown guardrails.'],
  ['Rivals & sharing', 'Leaderboards and session share cards.'],
] as const;

export default function Upgrade() {
  const { loading, configured, active, status, currentPeriodEnd, hasCustomer, refresh } = useSubscription();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searchParams] = useSearchParams();
  const checkoutResult = searchParams.get('checkout');

  const startCheckout = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await subscriptionApi.startCheckout();
      if (url) window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start checkout');
      setBusy(false);
    }
  };

  const openPortal = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await subscriptionApi.openPortal();
      if (url) window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open billing portal');
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100%', display: 'flex', justifyContent: 'center', padding: '40px 20px', backgroundColor: C.d0, color: C.t0 }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.acc, fontFamily: 'monospace' }}>
          Flyxa membership
        </p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', margin: '10px 0 8px' }}>
          The work after the close is the edge.
        </h1>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: C.t1, maxWidth: 480 }}>
          One plan, everything included. Cancel any time from the billing portal.
        </p>

        {checkoutResult === 'success' && (
          <p style={{ marginTop: 14, fontSize: 12.5, fontWeight: 600, color: C.grn }}>
            Payment received — your membership is being activated. This page updates within a minute.
          </p>
        )}

        <div style={{ marginTop: 22, border: `1px solid ${C.b0}`, borderRadius: 10, backgroundColor: C.d1, overflow: 'hidden' }}>
          <div style={{ height: 3, backgroundColor: C.acc }} />
          <div style={{ padding: '18px 20px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: C.t0 }}>Flyxa</p>
              <p style={{ fontSize: 11, color: C.t2, marginTop: 3 }}>Full access · all features</p>
            </div>
            {configured && (
              <span style={{
                fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                padding: '4px 10px', borderRadius: 4, border: `1px solid ${C.b0}`,
                color: active ? C.grn : C.t1,
              }}>
                {loading ? '…' : active ? (status === 'trialing' ? 'Trial active' : 'Active') : 'Not subscribed'}
              </span>
            )}
          </div>

          <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {FEATURES.map(([title, detail]) => (
              <div key={title} style={{ display: 'flex', gap: 10 }}>
                <span style={{ flexShrink: 0, fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: C.grn, marginTop: 1 }}>✓</span>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: C.t1 }}>
                  <span style={{ color: C.t0, fontWeight: 600 }}>{title}</span> — {detail}
                </p>
              </div>
            ))}
          </div>

          <div style={{ padding: '14px 20px 18px', borderTop: `1px solid ${C.b0}` }}>
            {!configured ? (
              <p style={{ fontSize: 12, color: C.t2, lineHeight: 1.6 }}>
                Billing isn't switched on in this environment yet — all features are open.
              </p>
            ) : active ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <p style={{ margin: 0, fontSize: 12, color: C.t1 }}>
                  {currentPeriodEnd
                    ? `Renews ${new Date(currentPeriodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : 'Membership active.'}
                </p>
                <button type="button" onClick={openPortal} disabled={busy}
                  style={{ padding: '9px 16px', borderRadius: 7, border: `1px solid ${C.b1}`, background: C.d2, color: C.t0, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  Manage billing
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <p style={{ margin: 0, fontSize: 12, color: C.t1 }}>Price shown at secure Stripe checkout.</p>
                <div style={{ display: 'flex', gap: 8 }}>
                  {hasCustomer && (
                    <button type="button" onClick={openPortal} disabled={busy}
                      style={{ padding: '10px 16px', borderRadius: 7, border: `1px solid ${C.b1}`, background: C.d2, color: C.t0, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                      Billing portal
                    </button>
                  )}
                  <button type="button" onClick={startCheckout} disabled={busy}
                    style={{ padding: '10px 22px', borderRadius: 7, border: 'none', background: C.acc, color: '#000', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                    {busy ? 'Opening…' : 'Start membership'}
                  </button>
                </div>
              </div>
            )}
            {error && <p style={{ margin: '10px 0 0', fontSize: 11.5, color: C.red }}>{error}</p>}
          </div>
        </div>

        {checkoutResult === 'success' && (
          <button type="button" onClick={() => void refresh()}
            style={{ marginTop: 12, background: 'none', border: 'none', color: C.t2, fontSize: 11, cursor: 'pointer', padding: 0 }}>
            Refresh status
          </button>
        )}
      </div>
    </div>
  );
}
