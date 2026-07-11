import { useLocation, Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.js';
import Header from './Header.js';
import RiskWarningBanner from '../risk/RiskWarningBanner.js';
import SessionStatusBar from './SessionStatusBar.js';
import FlyxaChatWidget from '../common/FlyxaChatWidget.js';
import InSessionTradeCheckDock from '../common/InSessionTradeCheckDock.js';
import WebsiteTour from '../common/WebsiteTour.js';
import UsernamePrompt from '../common/UsernamePrompt.js';
import ErrorBoundary from '../common/ErrorBoundary.js';
import GlobalMessagesPanel from '../messages/GlobalMessagesPanel.js';
import { useRisk } from '../../contexts/RiskContext.js';
import { useEvaluationAgent } from '../../hooks/useEvaluationAgent.js';
import { useRivalStatsSync } from '../../hooks/useRivalStatsSync.js';

export default function Layout() {
  useEvaluationAgent();
  useRivalStatsSync();
  const { riskLevel, dailyStatus } = useRisk();
  const location = useLocation();
  const isJournalWorkspace = location.pathname === '/scanner' || location.pathname === '/market-news';
  const isFullBleed = location.pathname === '/chart'
    || location.pathname === '/backtest'
    || location.pathname === '/trading-plan'
    || location.pathname === '/billing'
    || location.pathname === '/evaluation-coach'
    || location.pathname === '/market-news'
    || location.pathname === '/goals'
    || location.pathname === '/'
    || location.pathname === '/journal'
    || location.pathname === '/session'
    || location.pathname === '/rivals'
    || isJournalWorkspace;

  return (
    <div className="app-shell flex min-h-screen">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header />
        <SessionStatusBar />
        {riskLevel !== 'normal' && dailyStatus && (
          <RiskWarningBanner riskLevel={riskLevel} dailyStatus={dailyStatus} />
        )}
        <main className={isFullBleed ? 'flex-1 overflow-hidden p-0' : 'flex-1 overflow-auto p-4 md:p-8'}>
          <div className={isFullBleed ? 'h-full w-full' : 'mx-auto max-w-[1400px]'}>
            {/* Keyed by pathname so a crashed page's error state clears as soon
                as the user navigates somewhere else. */}
            <ErrorBoundary key={location.pathname}>
              <div key={location.key} className="page-transition h-full">
                <Outlet />
              </div>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <FlyxaChatWidget />
      <InSessionTradeCheckDock />
      <WebsiteTour />
      <UsernamePrompt />
      <GlobalMessagesPanel />
    </div>
  );
}
