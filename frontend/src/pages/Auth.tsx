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
                className={`auth-tab ${tab === 'waitlist' ? 'auth-tab--active' : ''}`}
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
