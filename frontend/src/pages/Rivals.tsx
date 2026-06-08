import { useMemo, useState } from 'react';
import { Check, Clock3, Plus, X } from 'lucide-react';
import { getRivalMetricValue } from '../lib/mascotProgression.js';
import { useRivals } from '../hooks/useRivals.js';
import type { RivalRequestResponse } from '../services/api.js';
import MascotCard from '../components/rivals/MascotCard.js';
import RivalsList from '../components/rivals/RivalsList.js';
import Leaderboard from '../components/rivals/Leaderboard.js';
import AddRivalModal from '../components/rivals/AddRivalModal.js';
import '../components/rivals/rivals.css';

export default function Rivals() {
  const { rivals, addRival, rivalRequests, respondToRequest } = useRivals();
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);
  const currentUser = rivals.find(rival => rival.isMe) ?? rivals[0];

  const quickStats = useMemo(() => {
    const others = rivals.filter(rival => !rival.isMe);
    const sortedByProcess = [...rivals].sort(
      (a, b) => getRivalMetricValue(b, 'processScore') - getRivalMetricValue(a, 'processScore'),
    );
    const myRank = sortedByProcess.findIndex(rival => rival.id === currentUser?.id) + 1;
    return {
      myRank: others.length > 0 ? myRank : null,
      dailyJournalStreak: currentUser?.mascot.stats.dailyJournalStreak ?? 0,
      dailyJournalScore: currentUser?.mascot.stats.dailyJournalScore ?? 0,
      tradingJournalScore: currentUser?.mascot.stats.tradingJournalScore ?? 0,
      backtestSessions: currentUser?.mascot.stats.backtestSessions ?? 0,
      processScore: currentUser?.mascot.stats.processScore ?? 0,
    };
  }, [
    currentUser?.id,
    currentUser?.mascot.stats.backtestSessions,
    currentUser?.mascot.stats.dailyJournalScore,
    currentUser?.mascot.stats.dailyJournalStreak,
    currentUser?.mascot.stats.processScore,
    currentUser?.mascot.stats.tradingJournalScore,
    rivals,
  ]);

  if (!currentUser) return null;

  const pendingRequests = rivalRequests.filter(request => request.status === 'pending');

  async function handleRequestAction(id: string, action: 'accept' | 'decline' | 'cancel') {
    setRequestBusyId(id);
    try {
      await respondToRequest(id, action);
    } finally {
      setRequestBusyId(null);
    }
  }

  return (
    <div className="rivals-page">
      <div className="rivals-shell">
        <div className="rivals-top">
          <div>
            <h1 className="rivals-title">Rivals</h1>
            <div className="rivals-top-meta">
              <p className="rivals-subtitle">Journal streak · trading coverage · backtests · process score</p>
              {quickStats.myRank && (
                <span className="rivals-rank-chip">RANK #{quickStats.myRank}</span>
              )}
            </div>
          </div>
          <button type="button" className="rivals-cta" onClick={() => setIsAddOpen(true)}>
            <Plus size={14} />
            Add Rival
          </button>
        </div>

        <div className="rivals-stats">
          <StatCard
            label="Daily Journal"
            value={`${quickStats.dailyJournalScore}/100`}
            tone="var(--rv-blue)"
            note={`${quickStats.dailyJournalStreak}d streak · recent entries still count`}
            percent={quickStats.dailyJournalScore}
          />
          <StatCard
            label="Trading Journal"
            value={`${quickStats.tradingJournalScore}%`}
            tone="var(--rv-amber)"
            note="Weekday entries with trades logged"
            percent={quickStats.tradingJournalScore}
          />
          <StatCard
            label="Backtesting Sessions"
            value={String(quickStats.backtestSessions)}
            tone="var(--rv-green)"
            note="All saved backtest sessions"
            percent={Math.min(100, quickStats.backtestSessions * 5)}
          />
          <StatCard
            label="Process Score"
            value={`${quickStats.processScore}/100`}
            tone="var(--rv-purple)"
            note={quickStats.myRank ? `Leaderboard rank #${quickStats.myRank}` : 'Rank appears after you add rivals'}
            percent={quickStats.processScore}
          />
        </div>

        {pendingRequests.length > 0 && (
          <div className="rivals-setup-grid">
            <section className="rv-card rivals-requests-card">
              <div className="rv-section-head">
                <div>
                  <div className="rv-section-kicker">Friend Requests</div>
                  <div className="rv-section-title">Pending invites</div>
                </div>
              </div>
              <div className="rivals-request-list">
                {pendingRequests.map(request => (
                  <RequestRow
                    key={request.id}
                    request={request}
                    busy={requestBusyId === request.id}
                    onAction={(action) => { void handleRequestAction(request.id, action); }}
                  />
                ))}
              </div>
            </section>
          </div>
        )}

        <div className="rivals-main-grid">
          <MascotCard mascot={currentUser.mascot} />
          <div className="rivals-stack">
            <RivalsList rivals={rivals} currentUser={currentUser} />
            <Leaderboard rivals={rivals} currentUserId={currentUser.id} defaultMetric="processScore" />
          </div>
        </div>
      </div>

      <AddRivalModal
        open={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSubmit={username => addRival(username)}
      />
    </div>
  );
}

function RequestRow({
  request,
  busy,
  onAction,
}: {
  request: RivalRequestResponse;
  busy: boolean;
  onAction: (action: 'accept' | 'decline' | 'cancel') => void;
}) {
  const profile = request.profile;
  const title = profile ? profile.displayName : 'Unknown trader';
  const subtitle = profile ? `@${profile.username}` : 'Profile unavailable';
  const isIncoming = request.direction === 'incoming';

  return (
    <div className="rivals-request-row">
      <div className="rivals-request-avatar" style={{ color: profile?.avatarColor ?? 'var(--rv-text-2)', borderColor: `${profile?.avatarColor ?? '#ffffff'}38`, background: `${profile?.avatarColor ?? '#ffffff'}14` }}>
        {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : profile?.avatarInitials ?? '??'}
      </div>
      <div className="rivals-request-copy">
        <strong>{title}</strong>
        <span>{isIncoming ? 'Wants to join your leaderboard' : 'Invite sent'} · {subtitle}</span>
      </div>
      <div className="rivals-request-actions">
        {isIncoming ? (
          <>
            <button type="button" className="request-accept" disabled={busy} onClick={() => onAction('accept')}>
              <Check size={13} />
              Accept
            </button>
            <button type="button" className="request-decline" disabled={busy} onClick={() => onAction('decline')}>
              <X size={13} />
              Decline
            </button>
          </>
        ) : (
          <button type="button" className="request-decline" disabled={busy} onClick={() => onAction('cancel')}>
            <Clock3 size={13} />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone, note, percent }: { label: string; value: string; tone: string; note: string; percent: number }) {
  return (
    <div className="rivals-stat" style={{ '--stat-tone': tone } as React.CSSProperties}>
      <div className="rivals-stat-label">{label}</div>
      <div className="rivals-stat-value" style={{ color: tone }}>{value}</div>
      <div className="rivals-stat-bar">
        <div className="rivals-stat-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%`, background: tone }} />
      </div>
      <div className="rivals-stat-note">{note}</div>
    </div>
  );
}
