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
    id: 'pre-session-tab',
    targetId: 'pre-session-header',
    path: '/pre-session',
    title: 'Session',
    body: 'Your before-trading checkpoint: check your mental state, confirm your risk limits, and commit to the plan before you take a single trade.',
    action: 'Next',
  },
  {
    id: 'scanner-tab',
    targetId: 'scanner-day-panel',
    path: '/scanner',
    title: 'Trade Scanner',
    body: 'Where trades enter the system. Drop a chart screenshot and Flyxa reads the entry, stop, and target, or import a broker CSV.',
    action: 'Next',
  },
  {
    id: 'journal-tab',
    targetId: 'journal-header',
    path: '/journal',
    title: 'Daily Journal',
    body: 'Your private space to review the session: what happened, what you learned, and how you felt. It autosaves as you write.',
    action: 'Next',
  },
  {
    id: 'analytics-tab',
    targetId: 'analytics-header',
    path: '/analytics',
    title: 'Analytics',
    body: 'Turns your logged trades into patterns: performance by period, the equity curve, time of day, sessions, and behaviour.',
    action: 'Next',
  },
  {
    id: 'flyxa-ai-tab',
    targetId: 'flyxa-ai-header',
    path: '/flyxa-ai',
    title: 'Flyxa AI',
    body: 'Explains your trading in plain English: debriefs, patterns, and coaching drawn straight from your journal and trades.',
    action: 'Next',
  },
  {
    id: 'evaluation-tab',
    targetId: 'evaluation-overview',
    path: '/evaluation-coach',
    title: 'Evaluation',
    body: 'Tracks prop-firm progress, drawdown buffer, and rule pressure, so you know what is left to pass without blowing the account.',
    action: 'Next',
  },
  {
    id: 'risk-rules-tab',
    targetId: 'risk-rules-framework',
    path: '/rules',
    title: 'Rules',
    body: 'Your risk rules are the operating system Flyxa uses to score plan adherence and flag when your process drifts.',
    action: 'Next',
  },
  {
    id: 'rivals-tab',
    targetId: 'rivals-header',
    path: '/rivals',
    title: 'Rivals',
    body: 'A private league: compare verified P&L, process, and consistency with your circle to stay accountable.',
    action: 'Next',
  },
  {
    id: 'settings-tab',
    targetId: 'settings-nav',
    path: '/settings',
    title: 'Settings',
    body: 'Set up your profile, trading accounts, session times, and scanner colours here. Do this early so every calculation stays accurate.',
    action: 'Finish',
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
    // Match the rendered width (min(360, 100vw - 32)) so the panel is always
    // clamped fully inside the viewport — otherwise it spills off the right
    // edge on narrow screens (and in the no-target fallback).
    const width = Math.min(360, window.innerWidth - 32);
    const maxLeft = Math.max(16, window.innerWidth - width - 16);
    if (!rect) return { left: clamp(220, 16, maxLeft), top: 96 };
    const roomRight = window.innerWidth - rect.right;
    const preferred = roomRight >= width + 28
      ? rect.right + 16
      : rect.left - width - 16;
    return {
      left: clamp(preferred, 16, maxLeft),
      top: clamp(rect.top - 8, 16, Math.max(16, window.innerHeight - 260)),
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
