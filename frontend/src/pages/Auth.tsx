import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.js';
import { waitlistApi } from '../services/api.js';
import ThemeToggle from '../components/common/ThemeToggle.js';
import FlyxaLogo from '../components/common/FlyxaLogo.js';

const features = [
  {
    title: 'Journal with context',
    description: 'Chart, execution notes, and trade rationale — all in one place.',
  },
  {
    title: 'Review without noise',
    description: 'Spot patterns in discipline, risk, and follow-through more clearly.',
  },
  {
    title: 'Built for real routines',
    description: 'A calm workspace for the work you do after the close.',
  },
];


export default function Auth() {
  const { signIn, signInWithGoogle, resetPassword } = useAuth();
  // Private beta: the second tab collects waitlist emails instead of creating
  // accounts. New signups are also disabled in Supabase Auth settings, so
  // existing beta accounts keep working and nobody else gets in.
  const [tab, setTab] = useState<'login' | 'waitlist'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    if (tab === 'login') {
      const { error } = await signIn(email, password);
      if (error) setError(error);
    } else {
      try {
        const { already } = await waitlistApi.join(email, 'app-auth');
        setSuccess(already
          ? "You're already on the list — we'll email you when your spot opens."
          : "You're on the list. We'll email you when your spot opens.");
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join the waitlist. Try again.');
      }
    }

    setLoading(false);
  };

  const handleGoogleAuth = async () => {
    setError('');
    setSuccess('');
    setLoading(true);
    const { error } = await signInWithGoogle();
    if (error) {
      setError(error);
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setError('');
    setSuccess('');
    if (!email.trim()) {
      setError('Enter your email first, then use Forgot password.');
      return;
    }
    setLoading(true);
    const { error } = await resetPassword(email);
    if (error) {
      setError(error);
    } else {
      setSuccess('Password reset email sent. Check your inbox.');
    }
    setLoading(false);
  };

  // The waitlist is its own minimal screen — one column, one field, no chrome.
  if (tab === 'waitlist') {
    return (
      <div className="auth-shell">
        <div className="auth-theme-toggle">
          <ThemeToggle compact />
        </div>

        <div className="auth-layout">

          {/* ── Left: the artifacts — scanner reading a chart, then the graded session card ── */}
          <section className="auth-left">
            <style>{`
              @keyframes flyxa-scan-sweep { 0% { left: 3%; } 50% { left: 95%; } 100% { left: 3%; } }
              .flyxa-scan-line { animation: flyxa-scan-sweep 4.5s ease-in-out infinite; }
              @media (prefers-reduced-motion: reduce) { .flyxa-scan-line { animation: none; left: 60%; } }
            `}</style>
            <div className="auth-left-inner" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>

              {/* Scanner card — a chart mid-scan */}
              <div style={{
                width: 410, maxWidth: '100%',
                border: '1px solid var(--app-border)',
                borderRadius: 14,
                backgroundColor: '#141211',
                overflow: 'hidden',
                marginBottom: 24,
                transform: 'rotate(-1.2deg)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
              }}>
                <div style={{ height: 3, backgroundColor: 'var(--accent)' }} />
                <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.14em', color: 'var(--app-text-subtle)' }}>
                    TRADE SCANNER
                  </p>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--app-text-muted)', border: '1px solid var(--app-border)', borderRadius: 4, padding: '2px 7px' }}>
                    MNQ · 5M
                  </span>
                </div>

                {/* Mini chart with entry/stop/target levels and a sweeping scan line */}
                <div style={{ position: 'relative', margin: '12px 18px 0', height: 128 }}>
                  <svg viewBox="0 0 340 96" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                    <line x1="0" y1="16" x2="340" y2="16" stroke="#22d68a" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="5 4" />
                    <line x1="0" y1="54" x2="340" y2="54" stroke="#f59e0b" strokeOpacity="0.6" strokeWidth="1" strokeDasharray="5 4" />
                    <line x1="0" y1="80" x2="340" y2="80" stroke="#f05252" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="5 4" />
                    {[
                      { x: 12,  wt: 40, wb: 62, bt: 44, bb: 58, bull: false },
                      { x: 32,  wt: 46, wb: 66, bt: 50, bb: 62, bull: false },
                      { x: 52,  wt: 46, wb: 64, bt: 50, bb: 58, bull: true },
                      { x: 72,  wt: 50, wb: 76, bt: 54, bb: 70, bull: false },
                      { x: 92,  wt: 60, wb: 79, bt: 66, bb: 78, bull: false },
                      { x: 112, wt: 60, wb: 79, bt: 64, bb: 76, bull: true },
                      { x: 132, wt: 50, wb: 70, bt: 54, bb: 66, bull: true },
                      { x: 152, wt: 52, wb: 66, bt: 56, bb: 62, bull: false },
                      { x: 172, wt: 42, wb: 64, bt: 46, bb: 60, bull: true },
                      { x: 192, wt: 34, wb: 52, bt: 38, bb: 48, bull: true },
                      { x: 212, wt: 36, wb: 52, bt: 40, bb: 48, bull: false },
                      { x: 232, wt: 30, wb: 50, bt: 34, bb: 46, bull: true },
                      { x: 252, wt: 22, wb: 40, bt: 26, bb: 36, bull: true },
                      { x: 272, wt: 16, wb: 32, bt: 20, bb: 28, bull: true },
                      { x: 292, wt: 15, wb: 24, bt: 18, bb: 22, bull: true },
                      { x: 312, wt: 14, wb: 26, bt: 17, bb: 23, bull: true },
                    ].map(c => (
                      <g key={c.x}>
                        <line x1={c.x + 5} y1={c.wt} x2={c.x + 5} y2={c.wb} stroke={c.bull ? '#22d68a' : '#f05252'} strokeWidth="1" />
                        <rect x={c.x} y={c.bt} width="10" height={Math.max(2, c.bb - c.bt)} rx="1" fill={c.bull ? '#22d68a' : '#f05252'} fillOpacity="0.85" />
                      </g>
                    ))}
                  </svg>
                  {/* Level tags */}
                  <span style={{ position: 'absolute', right: 2, top: 10, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.08em', color: '#22d68a' }}>TP</span>
                  <span style={{ position: 'absolute', left: 2, top: 60, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.08em', color: 'var(--accent)' }}>ENTRY</span>
                  <span style={{ position: 'absolute', right: 2, top: 94, fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.08em', color: '#f05252' }}>SL</span>
                  {/* Scan line */}
                  <span className="flyxa-scan-line" style={{ position: 'absolute', top: 0, bottom: 0, width: 1.5, backgroundColor: 'var(--accent)', opacity: 0.9 }} />
                </div>

                {/* Extracted readout */}
                <div style={{ margin: '12px 18px 0', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                  {[
                    ['DIR', 'LONG', '#22d68a'],
                    ['ENTRY', '21,482', 'var(--app-text)'],
                    ['STOP', '21,450', '#f05252'],
                    ['TARGET', '21,540', '#22d68a'],
                  ].map(([label, value, color]) => (
                    <div key={label}>
                      <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 7.5, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--app-text-subtle)' }}>{label}</p>
                      <p style={{ margin: '3px 0 0', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: color as string }}>{value}</p>
                    </div>
                  ))}
                </div>

                <div style={{ margin: '12px 0 0', borderTop: '1px solid var(--app-border)', padding: '9px 18px 11px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.1em', color: '#22d68a' }}>
                    ✓ TP HIT FIRST · EXIT 21,540 · TRADE LOGGED
                  </span>
                </div>
              </div>

              <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--app-text-muted)', textAlign: 'center', maxWidth: 330 }}>
                Screenshot in, verified trade out. The scanner reads the chart,
                checks your levels, and logs the trade for you.
              </p>
            </div>
          </section>

          <div className="auth-vdivider" aria-hidden="true" />

          {/* ── Right: the pitch and the one field that matters ── */}
          <section className="auth-right">
            <div className="auth-card">
              <div className="auth-card-mobile-logo">
                <FlyxaLogo
                  size={32}
                  showWordmark
                  wordmarkClassName="text-[1.3rem] font-bold tracking-[-0.04em]"
                  subtitleClassName="text-[10px] tracking-[0.5em]"
                />
              </div>

              <p style={{
                margin: 0,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}>
                Private beta · invite only
              </p>

              <h1 style={{
                margin: '14px 0 12px',
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.6rem, 2.6vw, 2rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
                color: 'var(--app-text)',
              }}>
                Join the waitlist.
              </h1>

              <p style={{ margin: '0 0 24px', fontSize: 13.5, lineHeight: 1.7, color: 'var(--app-text-muted)' }}>
                A small group of traders has access today. Leave your email and
                your invite arrives when a seat opens.
              </p>

              {success ? (
                <div className="auth-alert auth-alert--success">
                  <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{success}</span>
                </div>
              ) : (
                <form
                  onSubmit={handleSubmit}
                  style={{
                    display: 'flex',
                    width: '100%',
                    height: 50,
                    border: `1px solid ${emailFocused ? 'var(--accent)' : 'var(--app-border)'}`,
                    borderRadius: 10,
                    overflow: 'hidden',
                    backgroundColor: 'var(--app-panel-strong)',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    onFocus={() => setEmailFocused(true)}
                    onBlur={() => setEmailFocused(false)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    aria-label="Email"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      padding: '0 16px',
                      fontSize: 14,
                      color: 'var(--app-text)',
                    }}
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    style={{
                      flexShrink: 0,
                      border: 'none',
                      backgroundColor: 'var(--accent)',
                      color: '#0e0d0d',
                      fontWeight: 700,
                      fontSize: 13.5,
                      padding: '0 26px',
                      cursor: 'pointer',
                    }}
                  >
                    {loading ? '…' : 'Join waitlist'}
                  </button>
                </form>
              )}

              {error && (
                <div className="auth-alert auth-alert--error" style={{ marginTop: 10 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{error}</span>
                </div>
              )}

              <p style={{ margin: '14px 0 0', fontSize: 11, color: 'var(--app-text-subtle)' }}>
                No spam. One email when your seat opens — that's it.
              </p>

              <div style={{ marginTop: 26, borderTop: '1px solid var(--app-border)', paddingTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--app-text-subtle)' }}>
                  SEATS OPEN IN WAVES
                </span>
                <button
                  type="button"
                  onClick={() => { setTab('login'); setError(''); setSuccess(''); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11.5, color: 'var(--app-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0 }}
                >
                  Have an account? Sign in
                </button>
              </div>
            </div>
          </section>

        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-theme-toggle">
        <ThemeToggle compact />
      </div>

      <div className="auth-layout">

        {/* ── Left panel ── */}
        <section className="auth-left">
          <div className="auth-left-inner">
            <FlyxaLogo
              size={72}
              showWordmark
              className="auth-logo"
              wordmarkClassName="text-[3rem] font-bold tracking-[-0.05em]"
              subtitleClassName="text-[12px] tracking-[0.5em]"
            />

            <div className="auth-hero">
              <h1 className="auth-headline">
                Your edge is already<br />
                in your history.<br />
                <span className="auth-headline-em">Stop guessing.</span>
              </h1>
              <p className="auth-subhead">
                Do the work after the close. Build an edge that compounds.
              </p>
            </div>

            <div className="auth-features">
              {features.map((f) => (
                <div key={f.title} className="auth-feature-item">
                  <p className="auth-feature-title">{f.title}</p>
                  <p className="auth-feature-desc">{f.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Vertical divider ── */}
        <div className="auth-vdivider" aria-hidden="true" />

        {/* ── Right panel ── */}
        <section className="auth-right">
          <div className="auth-card">

            {/* Mobile-only logo */}
            <div className="auth-card-mobile-logo">
              <FlyxaLogo
                size={32}
                showWordmark
                wordmarkClassName="text-[1.3rem] font-bold tracking-[-0.04em]"
                subtitleClassName="text-[10px] tracking-[0.5em]"
              />
            </div>

            {/* Greeting */}
            <div className="auth-card-greeting">
              <p className="auth-card-title">
                {tab === 'login' ? 'Welcome back' : 'Flyxa is in private beta'}
              </p>
              <p className="auth-card-subtitle">
                {tab === 'login' ? 'Sign in to continue to Flyxa.' : 'Join the waitlist and we’ll email you when your spot opens.'}
              </p>
            </div>

            {/* Tab switcher */}
            <div className="auth-tabs">
              <button
                type="button"
                onClick={() => { setTab('login'); setError(''); setSuccess(''); }}
                className={`auth-tab ${tab === 'login' ? 'auth-tab--active' : ''}`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => { setTab('waitlist'); setError(''); setSuccess(''); }}
                className="auth-tab"
              >
                Join Waitlist
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="auth-form">

              <div className="auth-field">
                <label htmlFor="email" className="auth-label">Email</label>
                <input
                  id="email"
                  type="email"
                  className="auth-input"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                />
              </div>

              {tab === 'login' && (
                <div className="auth-field">
                  <div className="auth-field-header">
                    <label htmlFor="password" className="auth-label">Password</label>
                    <button
                      type="button"
                      onClick={() => void handleResetPassword()}
                      disabled={loading}
                      className="auth-forgot"
                    >
                      Forgot password?
                    </button>
                  </div>
                  <div className="auth-input-wrap">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      className="auth-input"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Password"
                      required
                      minLength={6}
                      autoComplete="current-password"
                      style={{ paddingRight: 40 }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(c => !c)}
                      className="auth-pw-toggle"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="auth-alert auth-alert--error">
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{error}</span>
                </div>
              )}

              {success && (
                <div className="auth-alert auth-alert--success">
                  <CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{success}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="auth-submit-btn"
              >
                {loading ? 'Please wait…' : tab === 'login' ? 'Sign In' : 'Join the Waitlist'}
              </button>
            </form>

            {tab === 'login' && (
              <>
                <div className="auth-divider"><span>or</span></div>

                <button
                  type="button"
                  onClick={() => void handleGoogleAuth()}
                  disabled={loading}
                  className="auth-google-btn"
                >
                  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908C16.658 14.233 17.64 11.925 17.64 9.2z" />
                    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" />
                    <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
                    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" />
                  </svg>
                  Continue with Google
                </button>
              </>
            )}

            <p className="auth-privacy-note">
              {tab === 'login' ? 'Private by default · Beta access only' : 'No spam — one email when your access is ready.'}
            </p>
            <p className="auth-privacy-note" style={{ marginTop: 6 }}>
              By continuing you agree to our{' '}
              <a href="/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>Terms</a>
              {' '}and{' '}
              <a href="/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy Policy</a>.
            </p>
          </div>
        </section>

      </div>
    </div>
  );
}
