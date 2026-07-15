import { AlertTriangle, XCircle, Lock } from 'lucide-react';
import { DailyStatus } from '../../types/index.js';

interface RiskWarningBannerProps {
  riskLevel: 'warning' | 'danger' | 'locked';
  dailyStatus: DailyStatus;
}

export default function RiskWarningBanner({ riskLevel, dailyStatus }: RiskWarningBannerProps) {
  const pct = dailyStatus.lossUsedPercent.toFixed(0);

  // Check consecutive losses
  const recentTrades = dailyStatus.todayTrades.slice(-3);
  const allLosses = recentTrades.length === 3 && recentTrades.every(t => t.exit_reason === 'SL');

  const bannerConfig = {
    warning: {
      bg: 'bg-amber-500/10 border-amber-500/30',
      text: 'text-amber-400',
      icon: <AlertTriangle size={16} />,
      message: `Approaching daily loss limit — ${pct}% used`,
    },
    danger: {
      bg: 'bg-red-500/10 border-red-500/30',
      text: 'text-red-400',
      icon: <XCircle size={16} />,
      message: `Near daily loss limit — ${pct}% used. Consider stopping.`,
    },
    locked: {
      bg: 'bg-red-900/30 border-red-600/50',
      text: 'text-red-300',
      icon: <Lock size={16} />,
      message: 'Daily loss limit reached. Trading locked for today.',
    },
  };

  const config = bannerConfig[riskLevel];

  return (
    <div className={`border-b px-6 py-2 ${config.bg}`}>
      <div className="flex items-center gap-6">
        <div className={`flex items-center gap-2 text-sm font-medium ${config.text}`}>
          {config.icon}
          {config.message}
        </div>
        {allLosses && (
          <div className="flex items-center gap-2 text-sm text-orange-400">
            <AlertTriangle size={14} />
            3 consecutive losses detected. Consider taking a break.
          </div>
        )}
      </div>
    </div>
  );
}
