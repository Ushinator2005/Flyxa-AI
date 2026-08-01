import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, CheckCircle2, Check, Copy, Gift, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.js';
import { waitlistApi } from '../services/api.js';
import ThemeToggle from '../components/common/ThemeToggle.js';
import FlyxaLogo from '../components/common/FlyxaLogo.js';

const features = [
  {
    title: 'Journal with context',
    description: 'Chart, execution notes, and trade rationale, all in one place.',
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
  // A /r/<code> link lands here as ?ref=<code>; carry it into the signup so it
  // can be attributed, and open straight to the waitlist form. A ?check=1 link
  // (from the confirmation email) opens the waitlist in "check your spot" mode.
  const [referralRef] = useState(() => new URLSearchParams(window.location.search).get('ref'));
  const [checkParam] = useState(() => new URLSearchParams(window.location.search).get('check') === '1');
  const [tab, setTab] = useState<'login' | 'waitlist'>(() => {
    const params = new URLSearchParams(window.location.search);
    // Landing-page CTAs land here with ?tab=waitlist (and optionally ?email=).
    if (params.get('tab') === 'waitlist' || params.get('email')) return 'waitlist';
    return referralRef || checkParam ? 'waitlist' : 'login';
  });
  const [email, setEmail] = useState(() => new URLSearchParams(window.location.search).get('email')?.trim().toLowerCase() ?? '');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [waitlistCount, setWaitlistCount] = useState<number | null>(null);
  const [standing, setStanding] = useState<{
    position: number | null;
    aheadOfYou: number | null;
    referralCode: string | null;
    referralUrl: string | null;
    referralCount: number;
    boostPer: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  // "Check your spot": the same email field, but a read-only lookup instead of
  // a signup, so returning traders can see their live position and referrals.
  const [checkMode, setCheckMode] = useState(checkParam);
  // When arriving via a referral link, resolve who referred them so the join
  // view can say so. Falls back to a generic label if the lookup fails.
  const [referrerName, setReferrerName] = useState<string | null>(null);

  useEffect(() => {
    if (!referralRef) return;
    let cancelled = false;
    waitlistApi.referrer(referralRef)
      .then(({ name }) => { if (!cancelled && name) setReferrerName(name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [referralRef]);

  // Live waitlist size for the social-proof line.
  useEffect(() => {
    let cancelled = false;
    waitlistApi.count()
      .then(({ count }) => { if (!cancelled && typeof count === 'number') setWaitlistCount(count); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Invite redemption — the only way to create an account. The token arrives
  // as ?invite=... from the seat-open email; the backend resolves it to an
  // email and creates the user with the service role (public signups stay
  // disabled in Supabase).
  const [inviteToken] = useState(() => new URLSearchParams(window.location.search).get('invite'));
  const [inviteStatus, setInviteStatus] = useState<'loading' | 'ready' | 'invalid'>('loading');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!inviteToken) return;
    waitlistApi.inviteInfo(inviteToken)
      .then(({ email: invitedEmail }) => {
        setInviteEmail(invitedEmail);
        setInviteStatus('ready');
      })
      .catch(err => {
        setInviteMessage(err instanceof Error ? err.message : 'This invite link is not valid.');
        setInviteStatus('invalid');
      });
  }, [inviteToken]);

  const clearInvite = () => {
    window.history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  };

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setLoading(true);
    try {
      await waitlistApi.redeemInvite(inviteToken ?? '', password);
      const { error: signInError } = await signIn(inviteEmail, password);
      if (signInError) setError(signInError);
      // On success the auth context routes into the app.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account. Try again.');
    }
    setLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    if (tab === 'login') {
      const { error } = await signIn(email, password);
      if (error) setError(error);
    } else if (checkMode) {
      try {
        const resp = await waitlistApi.standing(email);
        setStanding(resp);
        setSuccess('here');
      } catch {
        setError("We couldn't find that email on the waitlist. Join above to grab a spot.");
      }
    } else {
      try {
        const resp = await waitlistApi.join(email, 'app-auth', referralRef);
        setStanding({
          position: resp.position,
          aheadOfYou: resp.aheadOfYou,
          referralCode: resp.referralCode,
          referralUrl: resp.referralUrl,
          referralCount: resp.referralCount ?? 0,
          boostPer: resp.boostPer ?? 3,
        });
        setSuccess(resp.already
          ? "You're already on the list. We'll email you when your spot opens."
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

  const handleCopyReferral = async () => {
    if (!standing?.referralUrl) return;
    try {
      await navigator.clipboard.writeText(standing.referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the link
      // visible for a manual copy.
    }
  };

  // Invite redemption screen — same one-column composition as the waitlist.
  if (inviteToken) {
    return (
      <div className="auth-shell">
        <a className="auth-back-link" href="/landing/index.html" aria-label="Back to landing page">
          <ArrowLeft size={14} /> Back
        </a>
        <div className="auth-theme-toggle">
          <ThemeToggle compact />
        </div>

        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', textAlign: 'center' }}>
          <FlyxaLogo
            size={92}
            showWordmark
            wordmarkClassName="text-[3.2rem] font-bold tracking-[-0.05em]"
            subtitleClassName="text-[12px] tracking-[0.6em]"
          />

          <p style={{
            margin: '52px 0 0',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}>
            Private beta · seat open
          </p>

          {inviteStatus === 'loading' && (
            <p style={{ margin: '24px 0 0', fontSize: 14, color: 'var(--app-text-muted)' }}>
              Checking your invite…
            </p>
          )}

          {inviteStatus === 'invalid' && (
            <>
              <h1 style={{
                margin: '16px 0 12px',
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.7rem, 3.4vw, 2.2rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                color: 'var(--app-text)',
              }}>
                This invite won't open.
              </h1>
              <p style={{ margin: '0 0 26px', fontSize: 14, lineHeight: 1.7, color: 'var(--app-text-muted)', maxWidth: 420 }}>
                {inviteMessage}
              </p>
              <button
                type="button"
                onClick={clearInvite}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--app-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0 }}
              >
                Go to sign in
              </button>
            </>
          )}

          {inviteStatus === 'ready' && (
            <>
              <h1 style={{
                margin: '16px 0 12px',
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(2rem, 4vw, 2.7rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                color: 'var(--app-text)',
              }}>
                Create your account.
              </h1>

              <p style={{ margin: '0 0 30px', fontSize: 14, lineHeight: 1.7, color: 'var(--app-text-muted)', maxWidth: 400 }}>
                Your seat is reserved for{' '}
                <span style={{ color: 'var(--app-text)', fontWeight: 600 }}>{inviteEmail}</span>.
                Choose a password and you're in.
              </p>

              <form onSubmit={handleRedeem} style={{ width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
                <div className="auth-field">
                  <label htmlFor="invite-password" className="auth-label">Password</label>
                  <div className="auth-input-wrap">
                    <input
                      id="invite-password"
                      type={showPassword ? 'text' : 'password'}
                      className="auth-input"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      required
                      minLength={8}
                      autoComplete="new-password"
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

                <div className="auth-field">
                  <label htmlFor="invite-password-confirm" className="auth-label">Confirm password</label>
                  <input
                    id="invite-password-confirm"
                    type={showPassword ? 'text' : 'password'}
                    className="auth-input"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="Same password again"
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>

                {error && (
                  <div className="auth-alert auth-alert--error">
                    <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{error}</span>
                  </div>
                )}

                <button type="submit" disabled={loading} className="auth-submit-btn">
                  {loading ? 'Creating your account…' : 'Create account'}
                </button>
              </form>

              <p style={{ margin: '16px 0 0', fontSize: 11, color: 'var(--app-text-subtle)' }}>
                By continuing you agree to our{' '}
                <a href="/terms" style={{ color: 'inherit', textDecoration: 'underline' }}>Terms</a>
                {' '}and{' '}
                <a href="/privacy" style={{ color: 'inherit', textDecoration: 'underline' }}>Privacy Policy</a>.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  // The waitlist is its own minimal screen — one column, one field, no chrome.
  if (tab === 'waitlist') {
    return (
      <div className="auth-shell">
        <a className="auth-back-link" href="/landing/index.html" aria-label="Back to landing page">
          <ArrowLeft size={14} /> Back
        </a>
        <div className="auth-theme-toggle">
          <ThemeToggle compact />
        </div>

        {/* One centered column — the brand is the page */}
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 20px', textAlign: 'center' }}>
          <FlyxaLogo
            size={92}
            showWordmark
            wordmarkClassName="text-[3.2rem] font-bold tracking-[-0.05em]"
            subtitleClassName="text-[12px] tracking-[0.6em]"
          />

          {success ? (
            /* ── Confirmation — same centered composition as the join view ── */
            <>
              <p style={{
                margin: '52px 0 0',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}>
                <Check size={12} style={{ color: 'var(--color-green)' }} />
                You're on the list
              </p>

              <h1 style={{
                margin: '16px 0 12px',
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(2rem, 4vw, 2.7rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                color: 'var(--app-text)',
              }}>
                {checkMode ? "Here's your spot." : 'Seat reserved.'}
              </h1>

              <p style={{ margin: '0 0 34px', fontSize: 14, lineHeight: 1.7, color: 'var(--app-text-muted)', maxWidth: 430 }}>
                Invites go out in order. We'll email <b style={{ color: 'var(--app-text)', fontWeight: 600 }}>{email}</b> when it's your turn. One email, nothing else.
              </p>

              {standing?.position != null && (
                <div style={{ marginBottom: 34, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'var(--app-text-subtle)' }}>
                    Your position
                  </p>
                  <div style={{ position: 'relative', display: 'inline-block', margin: '12px 0 0' }}>
                    <span style={{ display: 'block', fontFamily: "'Space Grotesk', sans-serif", fontSize: 'clamp(3rem, 10vw, 4rem)', fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.02em', color: 'var(--accent)' }}>
                      #{standing.position.toLocaleString()}
                    </span>
                    <span style={{ position: 'absolute', left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 10, fontSize: 15, color: 'var(--app-text-muted)', whiteSpace: 'nowrap' }}>
                      in line
                    </span>
                  </div>
                </div>
              )}

              {standing?.referralUrl && (
                <div style={{ width: '100%', maxWidth: 460 }}>
                  <p style={{ margin: '0 0 8px', fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, letterSpacing: '0.24em', textTransform: 'uppercase', color: 'var(--app-text-subtle)' }}>
                    Move up the line
                  </p>
                  <p style={{ margin: '0 auto 14px', fontSize: 13.5, lineHeight: 1.7, color: 'var(--app-text-muted)', maxWidth: 420 }}>
                    Every trader who joins with your link moves you up <b style={{ color: 'var(--app-text)', fontWeight: 600 }}>{standing.boostPer} places</b>.
                    {standing.referralCount > 0 && ` ${standing.referralCount} joined so far.`}
                  </p>
                  <div style={{ display: 'flex', width: '100%', height: 52, border: '1px solid var(--app-border)', borderRadius: 11, overflow: 'hidden', backgroundColor: 'var(--app-panel-strong)' }}>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', padding: '0 18px', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--app-text-muted)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {standing.referralUrl.replace(/^https?:\/\/(www\.)?/, '')}
                    </div>
                    <button type="button" onClick={handleCopyReferral} style={{ flexShrink: 0, border: 'none', backgroundColor: 'var(--accent)', color: '#0e0d0d', fontWeight: 700, fontSize: 13.5, padding: '0 22px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                      {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy link</>}
                    </button>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => { setTab('login'); setError(''); setSuccess(''); setStanding(null); setCheckMode(false); }}
                style={{ marginTop: 40, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--app-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0 }}
              >
                Back to Flyxa
              </button>
            </>
          ) : (
            <>
              <p style={{
                margin: '52px 0 0',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
              }}>
                Private beta · invite only
              </p>

              <h1 style={{
                margin: '16px 0 12px',
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(2rem, 4vw, 2.7rem)',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
                color: 'var(--app-text)',
              }}>
                {checkMode ? 'Check your spot.' : 'Join the waitlist.'}
              </h1>

              <p style={{ margin: '0 0 18px', fontSize: 14, lineHeight: 1.7, color: 'var(--app-text-muted)', maxWidth: 400 }}>
                {checkMode
                  ? "Enter the email you signed up with to see your place in line and how many referrals you have."
                  : referralRef
                    ? "A friend saved you a spot in line. Leave your email and your invite arrives when a seat opens."
                    : "A small group of traders has access today. Leave your email and your invite arrives when a seat opens."}
              </p>

              {referralRef && !checkMode && (
                <div style={{
                  margin: '0 0 24px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  borderRadius: 8,
                  border: '1px solid var(--app-border)',
                  background: 'var(--app-panel)',
                  fontSize: 12.5,
                  color: 'var(--app-text-muted)',
                }}>
                  <Gift size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  {referrerName
                    ? <span>Referred by <b style={{ color: 'var(--app-text)', fontWeight: 600 }}>{referrerName}</b></span>
                    : <span>You were referred by a friend</span>}
                </div>
              )}

              {(() => {
                if (waitlistCount == null || waitlistCount < 1) return null;
                const label = waitlistCount >= 25 ? `${Math.floor(waitlistCount / 5) * 5}+` : String(waitlistCount);
                return (
                  <p style={{
                    margin: '6px 0 32px',
                    display: 'inline-flex',
                    alignItems: 'baseline',
                    gap: 10,
                    fontSize: 16,
                    color: 'var(--app-text-muted)',
                  }}>
                    <span style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 28,
                      fontWeight: 700,
                      letterSpacing: '-0.02em',
                      color: 'var(--app-text)',
                    }}>
                      {label}
                    </span>
                    traders already on the waitlist
                  </p>
                );
              })()}

              <form
                onSubmit={handleSubmit}
                style={{
                  display: 'flex',
                  width: '100%',
                  maxWidth: 460,
                  height: 52,
                  border: `1px solid ${emailFocused ? 'var(--accent)' : 'var(--app-border)'}`,
                  borderRadius: 11,
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
                    padding: '0 18px',
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
                    padding: '0 28px',
                    cursor: 'pointer',
                  }}
                >
                  {loading ? '…' : checkMode ? 'Check spot' : 'Join waitlist'}
                </button>
              </form>

              {error && (
                <div className="auth-alert auth-alert--error" style={{ width: '100%', maxWidth: 460, marginTop: 10 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{error}</span>
                </div>
              )}

              {!checkMode && (
                <p style={{ margin: '16px 0 0', fontSize: 11, color: 'var(--app-text-subtle)' }}>
                  An email will be sent when a seat is open.
                </p>
              )}

              <button
                type="button"
                onClick={() => { setCheckMode(m => !m); setError(''); setSuccess(''); }}
                style={{ marginTop: checkMode ? 22 : 18, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--app-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0 }}
              >
                {checkMode ? 'First time here? Join the waitlist' : 'Already joined? Check your spot'}
              </button>

              <button
                type="button"
                onClick={() => { setTab('login'); setError(''); setSuccess(''); }}
                style={{ marginTop: 18, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--app-text-muted)', textDecoration: 'underline', textUnderlineOffset: 3, padding: 0 }}
              >
                Have an account? Sign in
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <a className="auth-back-link" href="/landing/index.html" aria-label="Back to landing page">
        <ArrowLeft size={14} /> Back
      </a>
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
              {tab === 'login' ? 'Private by default · Beta access only' : 'An email will be sent when a seat is open.'}
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
