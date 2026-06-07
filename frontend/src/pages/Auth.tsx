import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.js';
import ThemeToggle from '../components/common/ThemeToggle.js';
import FlyxaLogo from '../components/common/FlyxaLogo.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';

const features = [
  {
    number: '01',
    title: 'Journal with context',
    description: 'Keep the chart, execution notes, and trade rationale in one place.',
  },
  {
    number: '02',
    title: 'Review without noise',
    description: 'See the patterns in discipline, risk, and follow-through more clearly.',
  },
  {
    number: '03',
    title: 'Built for real trading routines',
    description: 'A calm workspace for the work you do after the close, not just during the trade.',
  },
];

const tickerSymbols = ['ES', 'NQ', 'CL', 'GC', 'MES', 'MNQ', 'RTY', 'YM', 'ZB', 'ZN'];

export default function Auth() {
  const { signIn, signUp, signInWithGoogle, resetPassword } = useAuth();
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
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
      if (!name.trim()) {
        setError('Enter your name to create your account.');
        setLoading(false);
        return;
      }
      const { error } = await signUp(email, password, name);
      if (error) {
        setError(error);
      } else {
        setSuccess('Account created. Check your email to confirm, then sign in.');
        setTab('login');
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
      setSuccess('Password reset email sent. Check your inbox for the reset link.');
    }
    setLoading(false);
  };

  return (
    <div className="auth-shell min-h-screen">
      {/* Decorative background chart */}
      <svg
        className="auth-deco-chart"
        viewBox="0 0 1400 700"
        fill="none"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid slice"
      >
        <path
          d="M-100 550 C50 540 150 560 280 480 S460 380 600 320 S780 220 920 175 S1100 130 1260 95 S1380 75 1500 60"
          stroke="rgba(245,158,11,0.1)"
          strokeWidth="1.8"
          fill="none"
        />
        <path
          d="M-100 600 C80 588 200 605 340 540 S540 450 680 400 S880 310 1020 270 S1200 230 1360 200 S1440 185 1500 178"
          stroke="rgba(245,158,11,0.05)"
          strokeWidth="1.2"
          fill="none"
        />
        <circle cx="600" cy="320" r="3.5" fill="rgba(245,158,11,0.22)" />
        <circle cx="920" cy="175" r="3" fill="rgba(245,158,11,0.16)" />
        <circle cx="1260" cy="95" r="2.5" fill="rgba(245,158,11,0.12)" />
        <line x1="600" y1="320" x2="600" y2="700" stroke="rgba(245,158,11,0.055)" strokeWidth="1" strokeDasharray="4 6" />
        <line x1="920" y1="175" x2="920" y2="700" stroke="rgba(245,158,11,0.035)" strokeWidth="1" strokeDasharray="4 6" />
      </svg>

      {/* Theme toggle */}
      <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
        <ThemeToggle compact />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid w-full gap-12 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-start lg:gap-20">

          {/* ── Left panel — hidden on mobile ───────────────────────────────────── */}
          <section className="relative hidden flex-col justify-center lg:flex lg:pb-72">
            <FlyxaLogo
              size={86}
              showWordmark
              className="mb-8"
              wordmarkClassName="text-[4rem] font-light tracking-[-0.05em] sm:text-[4.4rem]"
              subtitleClassName="text-[11px] tracking-[0.56em] sm:text-xs"
            />

            {/* Stat chips */}
            <div className="mb-8 flex flex-wrap items-center gap-2">
              <span className="auth-stat-chip">14,000+ trades</span>
              <span className="auth-stat-sep" aria-hidden="true" />
              <span className="auth-stat-chip">100% private</span>
              <span className="auth-stat-sep" aria-hidden="true" />
              <span className="auth-stat-chip">Built for futures</span>
            </div>

            {/* Headline */}
            <div className="max-w-xl">
              <p className="auth-kicker mb-3">For dedicated traders</p>
              <h1 className="auth-headline">
                Most traders repeat
                <br />
                their mistakes.
                <span className="auth-headline-em"> You won't.</span>
              </h1>
              <p className="auth-subhead mt-5 max-w-lg">
                Flyxa is built for traders who still do the work after the session ends. Journal the
                trade, review the decision, and come back tomorrow stronger.
              </p>
            </div>

            {/* Ticker */}
            <div className="auth-ticker mt-10 max-w-2xl" aria-hidden="true">
              <div className="auth-ticker__track">
                {[...tickerSymbols, ...tickerSymbols].map((symbol, index) => (
                  <span key={`${symbol}-${index}`} className="auth-ticker__item">
                    {symbol}
                  </span>
                ))}
              </div>
            </div>

            {/* Features */}
            <div className="mt-10 max-w-xl">
              {features.map(feature => (
                <div key={feature.title} className="auth-feature-item">
                  <span className="auth-feature-num">{feature.number}</span>
                  <div>
                    <h2 className="auth-feature-title">{feature.title}</h2>
                    <p className="auth-feature-desc">{feature.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Right panel ─────────────────────────────────────────────────────── */}
          <section className="flex items-center justify-center lg:justify-end lg:pt-24">
            <Card className="auth-card w-full">
              <CardHeader className="px-7 pt-7 pb-0 sm:px-8 sm:pt-8">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="auth-card-eyebrow">
                      {tab === 'login' ? 'Sign in to your journal' : 'Create your account'}
                    </p>
                    <CardTitle className="auth-card-title mt-2">
                      {tab === 'login' ? 'Back to your edge' : 'Start with Flyxa'}
                    </CardTitle>
                    <CardDescription className="auth-card-desc mt-1.5 max-w-xs">
                      {tab === 'login'
                        ? 'The work continues.'
                        : 'Set up your workspace and start building a more consistent review habit.'}
                    </CardDescription>
                  </div>
                  <FlyxaLogo size={40} className="mt-1 shrink-0" />
                </div>
              </CardHeader>

              <CardContent className="space-y-5 px-7 pt-6 pb-7 sm:px-8 sm:pb-8">
                {/* Tab switcher */}
                <div className="auth-tabs">
                  <button
                    type="button"
                    onClick={() => setTab('login')}
                    className={`auth-tab ${tab === 'login' ? 'auth-tab--active' : ''}`}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab('signup')}
                    className={`auth-tab ${tab === 'signup' ? 'auth-tab--active' : ''}`}
                  >
                    Sign Up
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {tab === 'signup' && (
                    <div>
                      <Label htmlFor="name" className="auth-label mb-2 block">Name</Label>
                      <div className="relative">
                        <User
                          size={15}
                          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                          style={{ color: 'var(--app-text-subtle)' }}
                        />
                        <Input
                          id="name"
                          type="text"
                          className="auth-input pl-10"
                          value={name}
                          onChange={e => setName(e.target.value)}
                          placeholder="Your name"
                          required
                          autoComplete="name"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <Label htmlFor="email" className="auth-label mb-2 block">Email</Label>
                    <div className="relative">
                      <Mail
                        size={15}
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--app-text-subtle)' }}
                      />
                      <Input
                        id="email"
                        type="email"
                        className="auth-input pl-10"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        required
                        autoComplete="email"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <Label htmlFor="password" className="auth-label">Password</Label>
                      {tab === 'login' && (
                        <button
                          type="button"
                          onClick={() => void handleResetPassword()}
                          disabled={loading}
                          className="text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                          style={{ color: 'var(--app-text-muted)' }}
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock
                        size={15}
                        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--app-text-subtle)' }}
                      />
                      <Input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        className="auth-input pl-10 pr-11"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder={tab === 'signup' ? 'Min. 6 characters' : 'Enter your password'}
                        required
                        minLength={6}
                        autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(c => !c)}
                        className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg transition-colors"
                        style={{ color: 'var(--app-text-subtle)' }}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                      <div className="flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{error}</span>
                      </div>
                    </div>
                  )}

                  {success && (
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                        <span>{success}</span>
                      </div>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={loading}
                    className="auth-submit-btn w-full"
                  >
                    {loading ? 'Please wait…' : tab === 'login' ? 'Sign In' : 'Create Account'}
                  </Button>
                </form>

                <div className="auth-divider">
                  <span>or</span>
                </div>

                <button
                  type="button"
                  onClick={() => void handleGoogleAuth()}
                  disabled={loading}
                  className="auth-google-btn"
                >
                  <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908C16.658 14.233 17.64 11.925 17.64 9.2z" />
                    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" />
                    <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
                    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" />
                  </svg>
                  {tab === 'signup' ? 'Sign up with Google' : 'Continue with Google'}
                </button>

                <p className="auth-privacy-note">
                  Private by default · Email verification on signup
                </p>
              </CardContent>
            </Card>
          </section>

        </div>
      </div>
    </div>
  );
}
