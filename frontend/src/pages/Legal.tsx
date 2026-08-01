import { Link, useLocation } from 'react-router-dom';
import FlyxaLogo from '../components/common/FlyxaLogo.js';
import { C } from '../utils/theme.js';

// Public legal pages (/terms and /privacy). Plain-document styling on the app
// palette. NOTE: this is a solid working draft, not legal advice — have a
// lawyer review before charging customers.

const LAST_UPDATED = 'July 15, 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: C.t0, marginBottom: 10 }}>{title}</h2>
      <div style={{ fontSize: 13, lineHeight: 1.75, color: C.t1, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {children}
      </div>
    </section>
  );
}

function TermsContent() {
  return (
    <>
      <Section title="1. What Flyxa is, and is not">
        <p>
          Flyxa is a trading journal and performance-psychology tool. It helps you record trades,
          review your own behavior, and hold yourself to rules you define.
        </p>
        <p style={{ color: C.t0, fontWeight: 600 }}>
          Flyxa is not a broker, financial advisor, or trading-signal service. Nothing in the app —
          including AI-generated debriefs, coaching directives, readiness scores, or statistics, is
          financial advice or a recommendation to buy or sell any instrument. Trading futures and
          other leveraged products involves substantial risk of loss and is not suitable for everyone.
          You alone are responsible for your trading decisions and their outcomes.
        </p>
      </Section>

      <Section title="2. AI-generated content">
        <p>
          Parts of Flyxa (chart scanning, debriefs, coaching text) are produced by AI models. AI
          output can be wrong, incomplete, or misread your charts. Always verify scanned prices,
          results, and statistics against your broker records before relying on them.
        </p>
      </Section>

      <Section title="3. Your account">
        <p>
          You are responsible for keeping your login credentials secure and for all activity under
          your account. You must be of legal age in your jurisdiction to trade the products you journal.
        </p>
      </Section>

      <Section title="4. Subscriptions and billing">
        <p>
          Paid plans are billed in advance on a recurring basis and can be cancelled at any time,
          effective at the end of the current billing period. Prices may change with notice before
          your next renewal. Fees are non-refundable except where required by law.
        </p>
      </Section>

      <Section title="5. Your data">
        <p>
          Your journal entries, trades, and settings belong to you. We store them to provide the
          service (see the Privacy Policy). You can export your data from within the app and request
          deletion of your account and its data at any time.
        </p>
      </Section>

      <Section title="6. Acceptable use">
        <p>
          Do not abuse the service: no attempts to breach security, scrape other users' data,
          resell access, or overload the AI endpoints. We may suspend accounts that do.
        </p>
      </Section>

      <Section title="7. Warranty and liability">
        <p>
          Flyxa is provided "as is" without warranties of any kind. To the maximum extent permitted
          by law, we are not liable for trading losses, data inaccuracies, downtime, or indirect
          damages arising from use of the service. Prop-firm rule presets are monitoring aids, not a
          legal source of truth, always verify limits against your firm's own dashboard.
        </p>
      </Section>

      <Section title="8. Changes">
        <p>
          We may update these terms; material changes will be announced in the app before they take
          effect. Continued use after changes means you accept them.
        </p>
      </Section>
    </>
  );
}

function PrivacyContent() {
  return (
    <>
      <Section title="1. What we collect">
        <p>
          Account data (email, display name), the content you create (trades, journal entries,
          reflections, rules, settings, uploaded chart screenshots), and basic technical data needed
          to run the service.
        </p>
      </Section>

      <Section title="2. Where it lives">
        <p>
          Your data is stored in Supabase (our database and authentication provider). Chart images
          you upload are stored in Supabase storage under your account.
        </p>
      </Section>

      <Section title="3. AI processing">
        <p>
          When you use AI features, the relevant data is sent to AI providers to generate the result:
          chart screenshots and trade context are processed by Google (Gemini) for scanning, and
          journal/statistics context is processed by Anthropic (Claude) for coaching and debriefs.
          These providers process the data to serve your request; we do not sell your data to anyone.
        </p>
      </Section>

      <Section title="4. What we don't do">
        <p>
          We do not sell your personal data, show you third-party ads, or share your journal with
          other users. Rivals leaderboards only expose the stats you choose to compete with, under
          your chosen username.
        </p>
      </Section>

      <Section title="5. Your rights">
        <p>
          You can export your journal from the app, correct your data by editing it, and request
          full deletion of your account and data. Contact us through the app's feedback channel and
          we will action deletion requests promptly.
        </p>
      </Section>

      <Section title="6. Cookies and local storage">
        <p>
          We use browser storage only for your login session and ephemeral interface preferences
          (like a collapsed sidebar). Your journal data is not kept in your browser.
        </p>
      </Section>
    </>
  );
}

export default function Legal() {
  const { pathname } = useLocation();
  const isTerms = pathname === '/terms';

  return (
    <div style={{ minHeight: '100vh', backgroundColor: C.d0, color: C.t0, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '28px 20px 60px' }}>
      <div style={{ width: '100%', maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 34 }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'center', textDecoration: 'none' }}>
            <FlyxaLogo size={30} />
            <span style={{ marginLeft: 10, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}>Flyxa</span>
          </Link>
          <div style={{ display: 'flex', gap: 16 }}>
            <Link to="/terms" style={{ fontSize: 12, fontWeight: isTerms ? 700 : 500, color: isTerms ? C.t0 : C.t2, textDecoration: 'none' }}>Terms</Link>
            <Link to="/privacy" style={{ fontSize: 12, fontWeight: !isTerms ? 700 : 500, color: !isTerms ? C.t0 : C.t2, textDecoration: 'none' }}>Privacy</Link>
          </div>
        </div>

        <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.acc, fontFamily: 'monospace' }}>
          {isTerms ? 'Terms of service' : 'Privacy policy'}
        </p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '10px 0 6px' }}>
          {isTerms ? 'Terms of Service' : 'Privacy Policy'}
        </h1>
        <p style={{ fontSize: 11, color: C.t2, fontFamily: 'monospace' }}>Last updated {LAST_UPDATED}</p>

        {isTerms ? <TermsContent /> : <PrivacyContent />}

        <p style={{ marginTop: 40, paddingTop: 16, borderTop: `1px solid ${C.b0}`, fontSize: 11, color: C.t2, lineHeight: 1.6 }}>
          Questions about {isTerms ? 'these terms' : 'your data'}? Reach us through the in-app feedback button.
        </p>
      </div>
    </div>
  );
}
