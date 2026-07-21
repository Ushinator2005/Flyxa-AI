import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, X } from 'lucide-react';
import { useTrades } from '../../hooks/useTrades.js';

const TOUR_KEY = 'flyxa_website_tour_completed_v1';
const TOUR_ACTIVE_KEY = 'flyxa_website_tour_active_v1';
const SANS = 'var(--font-sans)';
const AMBER = '#f59e0b';
const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const BORDER = 'var(--app-border)';

interface TourStep {
  id: string;
  targetId: string;
  path: string;
  title: string;
  body: string;
  action: string;
}

const STEPS: TourStep[] = [
  {
    id: 'dashboard-tab',
    targetId: 'dashboard-overview',
    path: '/',
    title: 'Dashboard tab',
    body: 'Start here when you want the quick read on your trading day. It pulls your account, P&L, calendar, recent trades, and risk signals into one command center.',
    action: 'Start tour',
  },
  {
    id: 'dashboard-metrics',
    targetId: 'dashboard-metrics',
    path: '/',
    title: 'Dashboard metrics',
    body: 'These boxes summarize account balance, net P&L, win rate, average R:R, and trade count. They are the fastest way to know if the selected account is healthy.',
    action: 'Next',
  },
  {
    id: 'dashboard-account-filter',
    targetId: 'dashboard-account-filter',
    path: '/',
    title: 'Account filter',
    body: 'Use this dropdown to switch between all accounts or one specific account. Every chart and table on the Dashboard follows this selection.',
    action: 'Next',
  },
  {
    id: 'dashboard-log-trade',
    targetId: 'dashboard-log-trade',
    path: '/',
    title: 'Log trade button',
    body: 'This button sends you straight to the Trade Scanner. For a new account, this is usually the first action you should take.',
    action: 'Next',
  },
  {
    id: 'dashboard-calendar',
    targetId: 'dashboard-calendar',
    path: '/',
    title: 'P&L calendar',
    body: 'The calendar shows how each day performed. As you build history, it becomes the easiest place to spot streaks, bad weeks, and consistency.',
    action: 'Next',
  },
  {
    id: 'dashboard-recent-trades',
    targetId: 'dashboard-recent-trades',
    path: '/',
    title: 'Recent trades',
    body: 'This table gives you the latest executions with symbol, direction, R:R, P&L, and quick actions to review or delete a trade.',
    action: 'Next',
  },
  {
    id: 'pre-session-tab',
    targetId: 'pre-session-header',
    path: '/pre-session',
    title: 'Session tab',
    body: 'This tab is your before-trading checkpoint. It helps you slow down, check your mental state, confirm risk, and commit to the session plan.',
    action: 'Open Session',
  },
  {
    id: 'pre-session-mindset',
    targetId: 'pre-session-mindset',
    path: '/pre-session',
    title: 'State of mind',
    body: 'Pick your current emotional state and write a short pre-open note. This gives Flyxa context when it later reviews your execution.',
    action: 'Next',
  },
  {
    id: 'pre-session-risk',
    targetId: 'pre-session-risk',
    path: '/pre-session',
    title: 'Risk limits',
    body: 'This area shows max loss, max trades, contract limits, and target. Edit it when your account size or prop-firm rules change.',
    action: 'Next',
  },
  {
    id: 'pre-session-oath',
    targetId: 'pre-session-oath',
    path: '/pre-session',
    title: 'Trader oath',
    body: 'These are the promises you check off before trading. They are meant to interrupt impulsive trades before they happen.',
    action: 'Next',
  },
  {
    id: 'pre-session-checklist',
    targetId: 'pre-session-checklist',
    path: '/pre-session',
    title: 'Pre-session checklist',
    body: 'This is split into mental and technical checks. Complete it before taking trades so your decision is deliberate, not rushed.',
    action: 'Next',
  },
  {
    id: 'pre-session-begin',
    targetId: 'pre-session-begin',
    path: '/pre-session',
    title: 'Begin session',
    body: 'Once the checks are complete, accept the oath to begin the session. That tells Flyxa you planned before executing.',
    action: 'Next',
  },
  {
    id: 'scanner-tab',
    targetId: 'scanner-day-panel',
    path: '/scanner',
    title: 'Trade Scanner tab',
    body: 'This is where trades enter the system. The scanner can read chart screenshots or you can start a blank day and add details manually.',
    action: 'Open Scanner',
  },
  {
    id: 'scanner-upload',
    targetId: 'scanner-upload',
    path: '/scanner',
    title: 'Chart upload area',
    body: 'Drop a chart screenshot here or upload a file. Flyxa reads entry, stop, target, and exit zones from the chart when the colors are configured.',
    action: 'Next',
  },
  {
    id: 'scanner-import',
    targetId: 'scanner-import',
    path: '/scanner',
    title: 'CSV import',
    body: 'Use Import when you want to bring in broker exports instead of entering trades one by one. It maps CSV columns into journal trades.',
    action: 'Next',
  },
  {
    id: 'scanner-day-panel',
    targetId: 'scanner-day-panel',
    path: '/scanner',
    title: 'Day list',
    body: 'The left panel groups your trading days by month and shows monthly P&L, win rate, search, filters, and day grades.',
    action: 'Next',
  },
  {
    id: 'scanner-entry-panel',
    targetId: 'scanner-entry-panel',
    path: '/scanner',
    title: 'Trade detail panel',
    body: 'After a trade exists, this panel shows the screenshot, trade cards, contract sizing, price levels, reflections, psychology, and process score.',
    action: 'Next',
  },
  {
    id: 'journal-tab',
    targetId: 'journal-header',
    path: '/journal',
    title: 'Daily Journal tab',
    body: 'This is your private writing space. Use it after the session to capture what happened, what you learned, and how you felt.',
    action: 'Open Journal',
  },
  {
    id: 'journal-header',
    targetId: 'journal-header',
    path: '/journal',
    title: 'Journal momentum',
    body: 'The header shows how many journal entries you have and your current writing streak. It is a quick read on whether review is becoming a habit.',
    action: 'Next',
  },
  {
    id: 'journal-new-entry',
    targetId: 'journal-new-entry',
    path: '/journal',
    title: 'New entry',
    body: 'Click this to create a journal note for the day. The journal autosaves so you can write freely without managing drafts.',
    action: 'Next',
  },
  {
    id: 'journal-entry-list',
    targetId: 'journal-entry-list',
    path: '/journal',
    title: 'Entry list',
    body: 'The left column stores your journal entries by month. Search here when you want to find old reflections or review a specific day.',
    action: 'Next',
  },
  {
    id: 'journal-section-tabs',
    targetId: 'journal-section-tabs',
    path: '/journal',
    title: 'Journal sections',
    body: 'Entries are separated into reflection, lessons, and gratitude so your review stays structured instead of becoming one messy note.',
    action: 'Next',
  },
  {
    id: 'analytics-tab',
    targetId: 'analytics-header',
    path: '/analytics',
    title: 'Analytics tab',
    body: 'Analytics turns your logged trades into patterns. Use it once you have enough trades to compare sessions, symbols, conditions, and behavior.',
    action: 'Open Analytics',
  },
  {
    id: 'analytics-period-filter',
    targetId: 'analytics-period-filter',
    path: '/analytics',
    title: 'Period filter',
    body: 'Use these buttons to change the time window. This is important because last week, this month, and all-time performance can tell different stories.',
    action: 'Next',
  },
  {
    id: 'analytics-metrics',
    targetId: 'analytics-metrics',
    path: '/analytics',
    title: 'Performance metrics',
    body: 'These cards show net P&L, win rate, profit factor, average P&L, average R:R, and trade count for the selected period.',
    action: 'Next',
  },
  {
    id: 'analytics-equity-curve',
    targetId: 'analytics-equity-curve',
    path: '/analytics',
    title: 'Equity curve',
    body: 'This chart shows whether your account is trending up smoothly, chopping sideways, or taking sharp drawdowns.',
    action: 'Next',
  },
  {
    id: 'analytics-time-of-day',
    targetId: 'analytics-time-of-day',
    path: '/analytics',
    title: 'Time of day',
    body: 'This heatmap shows when you tend to make or lose money. It helps identify the trading windows worth keeping or avoiding.',
    action: 'Next',
  },
  {
    id: 'flyxa-ai-tab',
    targetId: 'flyxa-ai-header',
    path: '/flyxa-ai',
    title: 'Flyxa AI tab',
    body: 'Flyxa AI explains your trading data in plain English. It is where you go when you want patterns, debriefs, and coaching from your journal.',
    action: 'Open Flyxa AI',
  },
  {
    id: 'flyxa-ai-header',
    targetId: 'flyxa-ai-header',
    path: '/flyxa-ai',
    title: 'AI debrief window',
    body: 'This header controls the time window for the debrief and shows the selected period, session count, trade count, and net P&L.',
    action: 'Next',
  },
  {
    id: 'flyxa-ai-reflection',
    targetId: 'flyxa-ai-reflection',
    path: '/flyxa-ai',
    title: 'Reflection prompt',
    body: 'Flyxa asks a question based on your recent trading. Responding here helps build a record of how you were thinking.',
    action: 'Next',
  },
  {
    id: 'flyxa-ai-insights',
    targetId: 'flyxa-ai-insights',
    path: '/flyxa-ai',
    title: 'AI insights',
    body: 'These cards point out useful or dangerous patterns, then send you to the right next action such as journal, patterns, or pre-session rules.',
    action: 'Next',
  },
  {
    id: 'evaluation-tab',
    targetId: 'evaluation-overview',
    path: '/evaluation-coach',
    title: 'Evaluation',
    body: 'Evaluation tracks prop-firm progress, rule pressure, drawdown buffer, and the remaining work needed to pass without violating the account.',
    action: 'Open Evaluation',
  },
  {
    id: 'evaluation-overview',
    targetId: 'evaluation-overview',
    path: '/evaluation-coach',
    title: 'Evaluation overview',
    body: 'This page changes based on your account state: it can show setup guidance, live evaluation progress, rule warnings, or a pass-ready summary.',
    action: 'Next',
  },
  {
    id: 'backtest-tab',
    targetId: 'backtest-header',
    path: '/backtest',
    title: 'Backtest tab',
    body: 'Backtest is where you test a strategy before risking real money. It keeps replay sessions and results separate from live trades.',
    action: 'Open Backtest',
  },
  {
    id: 'backtest-new-session',
    targetId: 'backtest-new-session',
    path: '/backtest',
    title: 'New session',
    body: 'Start here to create a replay workspace. Choose market, timeframe, date range, and balance assumptions.',
    action: 'Next',
  },
  {
    id: 'backtest-current-focus',
    targetId: 'backtest-current-focus',
    path: '/backtest',
    title: 'Current focus',
    body: 'This panel shows the replay session you are currently working on and gives you a quick resume point.',
    action: 'Next',
  },
  {
    id: 'backtest-session-library',
    targetId: 'backtest-session-library',
    path: '/backtest',
    title: 'Session library',
    body: 'Saved sessions live here. Search, filter, resume, and compare old tests instead of losing them in notes.',
    action: 'Next',
  },
  {
    id: 'risk-rules-tab',
    targetId: 'risk-rules-framework',
    path: '/trading-plan',
    title: 'Rules',
    body: 'Your risk rules are the locked operating system Flyxa uses to score plan adherence and flag process drift.',
    action: 'Open Rules',
  },
  {
    id: 'trading-plan-record',
    targetId: 'trading-plan-core',
    path: '/trading-plan',
    title: 'The record',
    body: 'Below the rulebook sits the record: one bar per day — amber when every rule held, red when one broke — plus a per-rule breakdown of how consistently you follow each one.',
    action: 'Next',
  },
  {
    id: 'rivals-tab',
    targetId: 'rivals-header',
    path: '/rivals',
    title: 'Rivals',
    body: 'Rivals turns trading into a private league. Compare verified P&L, process, risk-adjusted performance, and weekly trade volume with your circle.',
    action: 'Open Rivals',
  },
  {
    id: 'rivals-controls',
    targetId: 'rivals-controls',
    path: '/rivals',
    title: 'League controls',
    body: 'Use these controls to switch metric, time frame, league, and search. The standings and selected trader panel update from the same filter.',
    action: 'Next',
  },
  {
    id: 'rivals-summary',
    targetId: 'rivals-standings',
    path: '/rivals',
    title: 'Your standing',
    body: 'This strip shows your rank, season progress, selected metric, and how far you are from the next trader above you.',
    action: 'Next',
  },
  {
    id: 'rivals-standings',
    targetId: 'rivals-standings',
    path: '/rivals',
    title: 'Standings',
    body: 'Each row shows rank, last five trading outcomes, trade count for the selected period, win rate, average R, consistency, and the active leaderboard metric.',
    action: 'Next',
  },
  {
    id: 'rivals-detail',
    targetId: 'rivals-detail',
    path: '/rivals',
    title: 'Trader detail',
    body: 'Select a trader to inspect their equity curve, period stats, progress, ranks, and recent trades without leaving the leaderboard.',
    action: 'Next',
  },
  {
    id: 'billing-tab',
    targetId: 'billing-header',
    path: '/billing',
    title: 'Billing',
    body: 'Billing tracks prop-firm spend, account purchases, resets, activation fees, discounts, payouts, and account ROI.',
    action: 'Open Billing',
  },
  {
    id: 'billing-actions',
    targetId: 'billing-actions',
    path: '/billing',
    title: 'Billing import tools',
    body: 'Import accounts from Excel, download the template, or add one account manually. The importer preserves real $0 charges instead of replacing them with list price.',
    action: 'Next',
  },
  {
    id: 'billing-overview',
    targetId: 'billing-overview',
    path: '/billing',
    title: 'Funding overview',
    body: 'This dashboard summarizes net position, spend, payouts, savings, pass rate, monthly burn, and cost per pass.',
    action: 'Next',
  },
  {
    id: 'billing-payouts',
    targetId: 'billing-payouts',
    path: '/billing',
    title: 'Payout gallery',
    body: 'Payout screenshots now live in Billing so your proof of funded-account returns stays beside spend, ROI, and account history.',
    action: 'Next',
  },
  {
    id: 'billing-ledger',
    targetId: 'billing-ledger',
    path: '/billing',
    title: 'Account ledger',
    body: 'The ledger is the source of truth for every prop account event: combines, resets, monthly subscriptions, XFA activations, status, purchase date, and notes.',
    action: 'Next',
  },
  {
    id: 'goals-tab',
    targetId: 'goals-hero',
    path: '/goals',
    title: 'Goals tab',
    body: 'Goals keep the long-term reason visible. Use this for targets that should influence discipline, not just motivation.',
    action: 'Open Goals',
  },
  {
    id: 'goals-new-goal',
    targetId: 'goals-new-goal',
    path: '/goals',
    title: 'New goal',
    body: 'Create a goal here, then break it into measurable milestones so progress is visible rather than vague.',
    action: 'Next',
  },
  {
    id: 'goals-filters',
    targetId: 'goals-filters',
    path: '/goals',
    title: 'Goal filters',
    body: 'Filter by status and category when your goal list grows. This keeps active goals separate from achieved or paused ones.',
    action: 'Next',
  },
  {
    id: 'settings-tab',
    targetId: 'settings-header',
    path: '/settings',
    title: 'Settings tab',
    body: 'Settings controls the account and app data that the rest of Flyxa depends on. Set this up early so calculations are accurate.',
    action: 'Open Settings',
  },
  {
    id: 'settings-nav',
    targetId: 'settings-nav',
    path: '/settings',
    title: 'Settings sections',
    body: 'These cards jump to each settings section. Use them instead of scrolling when you need profile, scanner, or account controls.',
    action: 'Next',
  },
  {
    id: 'settings-data-safety',
    targetId: 'settings-data-safety',
    path: '/settings',
    title: 'Data safety',
    body: 'Export backups, import JSON, and recover missing trades from the browser cache here. Use this before big imports or if local and cloud data ever drift.',
    action: 'Next',
  },
  {
    id: 'settings-scanner',
    targetId: 'settings-scanner',
    path: '/settings',
    title: 'Scanner colors',
    body: 'Match these colors to the zone boxes on your TradingView chart. This helps the scanner identify entry, stop loss, and take profit correctly.',
    action: 'Next',
  },
  {
    id: 'settings-accounts',
    targetId: 'settings-accounts',
    path: '/settings',
    title: 'Trading accounts',
    body: 'Add accounts, broker names, starting balances, account type, and status here. Dashboard and journal filters use this data.',
    action: 'Next',
  },
];

function readCompleted() {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(TOUR_KEY) === '1';
}

function readActive() {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(TOUR_ACTIVE_KEY) === '1';
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export default function WebsiteTour() {
  const { trades } = useTrades();
  const navigate = useNavigate();
  const location = useLocation();
  const [completed, setCompleted] = useState(readCompleted);
  const [tourActive, setTourActive] = useState(readActive);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const shouldShow = tourActive || (!completed && trades.length === 0);
  const step = STEPS[stepIndex];
  const onStepPath = location.pathname === step.path;

  const markDone = useCallback(() => {
    window.localStorage.setItem(TOUR_KEY, '1');
    window.localStorage.removeItem(TOUR_ACTIVE_KEY);
    setTourActive(false);
    setCompleted(true);
  }, []);

  useEffect(() => {
    const restart = () => {
      window.localStorage.removeItem(TOUR_KEY);
      window.localStorage.setItem(TOUR_ACTIVE_KEY, '1');
      setStepIndex(0);
      setTourActive(true);
      setCompleted(false);
      navigate('/');
    };
    window.addEventListener('flyxa:restart-tour', restart);
    return () => window.removeEventListener('flyxa:restart-tour', restart);
  }, [navigate]);

  const updateRect = useCallback(() => {
    if (!shouldShow) return;
    const target = document.querySelector<HTMLElement>(`[data-tour-id="${step.targetId}"]`)
      ?? document.querySelector<HTMLElement>(`[data-tour-id="${step.id}"]`);
    target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    setRect(target?.getBoundingClientRect() ?? null);
  }, [shouldShow, step.id, step.targetId]);

  useEffect(() => {
    if (!shouldShow) return;
    updateRect();
    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const timers = [80, 220, 460, 800, 1200].map(delay => window.setTimeout(updateRect, delay));
    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
    };
  }, [location.pathname, shouldShow, updateRect]);

  useEffect(() => {
    if (!shouldShow) return;
    const handler = (event: MouseEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest(`[data-tour-id="${step.targetId}"], [data-tour-id="${step.id}"]`)
        : null;
      if (!target) return;
      window.setTimeout(() => {
        if (stepIndex < STEPS.length - 1) setStepIndex(current => current + 1);
        else markDone();
      }, 140);
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [markDone, shouldShow, step.id, step.targetId, stepIndex]);

  const panelStyle = useMemo(() => {
    const width = 330;
    const fallback = { left: 220, top: 96 };
    if (!rect) return fallback;
    const roomRight = window.innerWidth - rect.right;
    const left = roomRight >= width + 28
      ? rect.right + 16
      : Math.max(16, rect.left - width - 16);
    return {
      left,
      top: clamp(rect.top - 8, 16, Math.max(16, window.innerHeight - 230)),
    };
  }, [rect]);

  if (!shouldShow) return null;

  const goBack = () => {
    const next = Math.max(0, stepIndex - 1);
    setStepIndex(next);
    navigate(STEPS[next].path);
  };

  const goNext = () => {
    if (!onStepPath) {
      navigate(step.path);
      return;
    }
    if (stepIndex >= STEPS.length - 1) {
      markDone();
      return;
    }
    const next = stepIndex + 1;
    setStepIndex(next);
    navigate(STEPS[next].path);
  };

  return (
    <>
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 900,
          pointerEvents: 'none',
          background: 'rgba(4,4,4,0.42)',
        }}
      />

      {rect && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            zIndex: 902,
            left: rect.left - 5,
            top: rect.top - 5,
            width: rect.width + 10,
            height: rect.height + 10,
            borderRadius: 9,
            border: `2px solid ${AMBER}`,
            boxShadow: `0 0 0 9999px rgba(0,0,0,0.18), 0 0 22px ${AMBER}55`,
            pointerEvents: 'none',
          }}
        />
      )}

      <section
        role="dialog"
        aria-modal="false"
        aria-label="Website tour"
        style={{
          position: 'fixed',
          zIndex: 903,
          left: panelStyle.left,
          top: panelStyle.top,
          width: 'min(360px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 32px)',
          borderRadius: 10,
          border: `1px solid ${AMBER}35`,
          background: S1,
          boxShadow: '0 18px 50px rgba(0,0,0,0.52)',
          overflow: 'hidden',
          fontFamily: SANS,
        }}
      >
        <div style={{ height: 2, background: AMBER }} />
        <div style={{ padding: '15px 16px 14px', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 34px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginBottom: 4, flexShrink: 0 }}>
            <button
              type="button"
              onClick={markDone}
              title="Skip tour"
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                border: 'none',
                background: 'transparent',
                color: T3,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={13} />
            </button>
          </div>

          <h2 style={{ margin: '0 0 7px', color: T1, fontSize: 16, fontWeight: 700, letterSpacing: '-0.015em' }}>
            {step.title}
          </h2>
          <div style={{ overflowY: 'auto', minHeight: 0, paddingRight: 2 }}>
            <p style={{ margin: 0, color: T2, fontSize: 12.5, lineHeight: 1.6 }}>
              {step.body}
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: 8, marginTop: 14, flexShrink: 0 }}>
            <button
              type="button"
              onClick={goBack}
              disabled={stepIndex === 0}
              style={{
                height: 31,
                padding: '0 10px',
                borderRadius: 6,
                border: `1px solid ${BORDER}`,
                background: S2,
                color: stepIndex === 0 ? T3 : T2,
                opacity: stepIndex === 0 ? 0.45 : 1,
                cursor: stepIndex === 0 ? 'default' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: SANS,
              }}
            >
              Back
            </button>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', overflow: 'hidden' }}>
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: i === stepIndex ? 14 : 4,
                    height: 4,
                    borderRadius: 999,
                    background: i === stepIndex ? AMBER : 'rgba(255,255,255,0.15)',
                    flexShrink: i === stepIndex ? 0 : 1,
                    transition: 'width 0.15s',
                  }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={goNext}
              style={{
                height: 31,
                padding: '0 11px',
                borderRadius: 6,
                border: 'none',
                background: AMBER,
                color: '#11100f',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 750,
                fontFamily: SANS,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {stepIndex >= STEPS.length - 1 && onStepPath ? 'Finish' : onStepPath ? 'Next tab' : step.action}
              {stepIndex >= STEPS.length - 1 && onStepPath ? <Check size={13} /> : <ArrowRight size={13} />}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
