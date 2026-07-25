import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SectionPanel } from '../ds/SectionPanel.js';
import { waitlistApi } from '../../services/api.js';

const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const BORDER = 'var(--app-border)';
const PANEL = 'var(--app-panel)';
const AMBER = 'var(--color-amber)';
const MONO = 'var(--font-mono)';

interface Stats {
  totals: { total: number; real: number; invited: number; redeemed: number; viaReferral: number; base: number; boostPer: number };
  topReferrers: Array<{ code: string; email: string | null; referrals: number; position: number | null }>;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ flex: 1, minWidth: 120, padding: '12px 14px', borderRadius: 10, border: `1px solid ${BORDER}`, background: PANEL }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: T3 }}>{label}</div>
      <div style={{ marginTop: 6, fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: T1 }}>{value}</div>
    </div>
  );
}

// Founder-only referral dashboard. The backend gates this to the founder email
// and returns a 403 to anyone else, so a non-founder simply sees the error line.
export default function WaitlistReferralsPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    waitlistApi.adminReferrals()
      .then(setStats)
      .catch(err => setError(err instanceof Error ? err.message : 'Could not load referral stats.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div style={{ marginTop: 12 }}>
      <SectionPanel
        title="Waitlist referrals"
        subtitle="Who's driving signups, and the current shape of the queue."
        right={
          <button
            type="button"
            onClick={load}
            aria-label="Refresh referral stats"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${BORDER}`, background: 'transparent', color: T2, fontSize: 12, cursor: 'pointer' }}
          >
            <RefreshCw size={12} style={{ opacity: loading ? 0.5 : 1 }} />
            Refresh
          </button>
        }
      >
        {error ? (
          <p style={{ fontSize: 12, color: T3, lineHeight: 1.6 }}>{error}</p>
        ) : !stats ? (
          <p style={{ fontSize: 12, color: T3 }}>{loading ? 'Loading…' : 'No data.'}</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <Tile label="On the list" value={stats.totals.total.toLocaleString()} />
              <Tile label="Via referral" value={stats.totals.viaReferral.toLocaleString()} />
              <Tile label="Invited" value={stats.totals.invited.toLocaleString()} />
              <Tile label="Accounts made" value={stats.totals.redeemed.toLocaleString()} />
            </div>

            {stats.totals.base > 0 && (
              <p style={{ marginTop: 10, fontSize: 11, color: T3 }}>
                Displayed count includes a social-proof base of {stats.totals.base.toLocaleString()} ({stats.totals.real.toLocaleString()} real signups).
              </p>
            )}

            <div style={{ marginTop: 18, fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: T3 }}>
              Top referrers
            </div>

            {stats.topReferrers.length === 0 ? (
              <p style={{ marginTop: 10, fontSize: 12, color: T3, lineHeight: 1.6 }}>
                No referrals yet. Each friend who joins with someone's link moves them up {stats.totals.boostPer} places.
              </p>
            ) : (
              <div style={{ marginTop: 10, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                {/* Header row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px', gap: 12, padding: '9px 14px', borderBottom: `1px solid ${BORDER}`, fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: T3 }}>
                  <span>Trader</span>
                  <span style={{ textAlign: 'right' }}>Referrals</span>
                  <span style={{ textAlign: 'right' }}>Position</span>
                </div>
                {stats.topReferrers.map((r, i) => (
                  <div
                    key={r.code}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 90px 90px', gap: 12, alignItems: 'center', padding: '11px 14px', borderBottom: i === stats.topReferrers.length - 1 ? 'none' : `1px solid ${BORDER}` }}
                  >
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: T1 }}>
                      {r.email ?? r.code}
                    </span>
                    <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: 13, fontWeight: 500, color: AMBER }}>
                      {r.referrals}
                    </span>
                    <span style={{ textAlign: 'right', fontFamily: MONO, fontSize: 13, color: T2 }}>
                      {r.position != null ? `#${r.position.toLocaleString()}` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SectionPanel>
    </div>
  );
}
