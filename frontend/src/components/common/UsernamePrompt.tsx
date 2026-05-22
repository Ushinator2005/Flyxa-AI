import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.js';
import { rivalsApi } from '../../services/api.js';
import FlyxaLogo from './FlyxaLogo.js';

const AMBER = '#f59e0b';
const AMBER_DIM = 'rgba(245,158,11,0.10)';
const BORDER = 'var(--app-border)';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const T1 = 'var(--app-text)';
const T3 = 'var(--app-text-subtle)';
const SANS = 'var(--font-sans)';

function normalizeUsername(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

function usernameFromUser(email?: string, displayName?: string): string {
  const source = displayName || email?.split('@')[0] || '';
  return normalizeUsername(source.replace(/\s+/g, '_'));
}

export default function UsernamePrompt() {
  const { user } = useAuth();
  const [checking, setChecking] = useState(true);
  const [needsUsername, setNeedsUsername] = useState(false);
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const displayName = useMemo(() => {
    if (!user) return 'Trader';
    return (user.user_metadata?.name as string | undefined)
      || (user.user_metadata?.full_name as string | undefined)
      || user.email?.split('@')[0]
      || 'Trader';
  }, [user]);

  useEffect(() => {
    if (!user) {
      setChecking(false);
      setNeedsUsername(false);
      return;
    }

    let cancelled = false;
    setChecking(true);
    rivalsApi.getProfile()
      .then((profile) => {
        if (cancelled) return;
        setNeedsUsername(!profile?.username);
        setUsername(current => current || usernameFromUser(user.email, displayName));
      })
      .catch(() => {
        if (!cancelled) setNeedsUsername(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => { cancelled = true; };
  }, [displayName, user]);

  async function handleSave() {
    const cleaned = normalizeUsername(username);
    setUsername(cleaned);

    if (cleaned.length < 3) {
      setStatus('Use at least 3 characters.');
      return;
    }

    setSaving(true);
    setStatus('');
    try {
      await rivalsApi.updateProfile({ username: cleaned, displayName: cleaned });
      window.dispatchEvent(new CustomEvent('flyxa:profile-saved'));
      setNeedsUsername(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save username.');
    } finally {
      setSaving(false);
    }
  }

  if (checking || !needsUsername) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="username-prompt-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1400,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        /* Match the site's dark charcoal backdrop, not blue-ish */
        background: 'rgba(10,8,6,0.88)',
        backdropFilter: 'blur(14px)',
        fontFamily: SANS,
      }}
    >
      <section
        style={{
          width: 'min(460px, 100%)',
          borderRadius: 14,
          border: '1px solid rgba(245,158,11,0.16)',
          background: S1,
          boxShadow: 'none',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Top amber accent line */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background:
            'linear-gradient(90deg, transparent 0%, rgba(245,158,11,0.4) 20%, #f59e0b 50%, rgba(245,158,11,0.3) 80%, transparent 100%)',
          zIndex: 1,
        }} />

        {/* ── Header ── */}
        <div style={{
          padding: '32px 28px 26px',
          borderBottom: `1px solid rgba(255,255,255,0.05)`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Flyxa logo mark only */}
          <div style={{ position: 'relative', marginBottom: 22 }}>
            <FlyxaLogo size={48} showWordmark={false} />
          </div>

          <h2
            id="username-prompt-title"
            style={{
              margin: 0,
              color: T1,
              fontSize: 20,
              fontWeight: 660,
              letterSpacing: '-0.025em',
              lineHeight: 1.2,
              position: 'relative',
            }}
          >
            Choose your username
          </h2>
          <p style={{
            margin: '9px 0 0',
            color: T3,
            fontSize: 12.5,
            lineHeight: 1.6,
            maxWidth: 340,
            position: 'relative',
          }}>
            Your public handle for rival requests and leaderboards.
            You can change this anytime in Settings.
          </p>
        </div>

        {/* ── Form ── */}
        <div style={{ padding: '24px 28px 28px' }}>
          <label style={{ display: 'block' }}>
            <span style={{
              display: 'block',
              marginBottom: 8,
              color: T3,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
            }}>
              Username
            </span>

            {/* Input with attached @ prefix */}
            <div style={{
              display: 'flex',
              alignItems: 'stretch',
              height: 44,
              borderRadius: 8,
              border: `1px solid ${BORDER}`,
              background: S2,
              overflow: 'hidden',
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 13px',
                borderRight: `1px solid ${BORDER}`,
                background: AMBER_DIM,
                flexShrink: 0,
              }}>
                <span style={{ color: AMBER, fontSize: 14, fontWeight: 700 }}>@</span>
              </div>
              <input
                autoFocus
                value={username}
                placeholder="your_username"
                onChange={event => setUsername(normalizeUsername(event.target.value))}
                onKeyDown={event => { if (event.key === 'Enter') void handleSave(); }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: '100%',
                  border: 'none',
                  background: 'transparent',
                  color: T1,
                  outline: 'none',
                  padding: '0 14px',
                  fontSize: 13.5,
                  fontFamily: SANS,
                  letterSpacing: '0.01em',
                }}
              />
            </div>
          </label>

          <p style={{ margin: '8px 0 0', color: T3, fontSize: 11, lineHeight: 1.5 }}>
            3–24 characters · letters, numbers, underscores only
          </p>

          {status && (
            <p style={{
              margin: '10px 0 0',
              color: AMBER,
              fontSize: 12,
              fontWeight: 600,
            }}>
              {status}
            </p>
          )}

          <button
            type="button"
            disabled={saving}
            onClick={() => { void handleSave(); }}
            style={{
              width: '100%',
              height: 44,
              marginTop: 20,
              borderRadius: 8,
              border: 'none',
              background: saving
                ? 'rgba(245,158,11,0.45)'
                : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
              color: '#0a0806',
              fontSize: 13.5,
              fontWeight: 750,
              cursor: saving ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              letterSpacing: '0.01em',
              boxShadow: saving ? 'none' : '0 4px 20px rgba(245,158,11,0.22)',
              transition: 'opacity 0.15s',
            }}
          >
            <Check size={15} strokeWidth={2.5} />
            {saving ? 'Saving…' : 'Continue to Flyxa'}
          </button>
        </div>
      </section>
    </div>
  );
}
