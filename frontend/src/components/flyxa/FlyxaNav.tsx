import { NavLink } from 'react-router-dom';

const colors = {
  d1: '#141312',
  b0: 'rgba(255,255,255,0.07)',
  t0: '#e8e3dc',
  t1: '#8a8178',
  t2: '#5c5751',
  acc: '#f59e0b',
};

const NAV_ITEMS = [
  { key: 'weekly',         label: 'Weekly debrief',       to: '/flyxa-ai',                        end: true  },
  { key: 'weekly-report',  label: 'Weekly report',        to: '/flyxa-ai/weekly-report',          end: false },
  { key: 'execution',      label: 'Execution coach',      to: '/flyxa-ai/execution-coach',        end: false },
  { key: 'pattern',        label: 'Pattern library',      to: '/flyxa-ai/patterns',               end: false },
  { key: 'emotional',      label: 'Emotional fingerprint', to: '/flyxa-ai/emotional-fingerprint', end: false },
  { key: 'ask',            label: 'Ask Flyxa',            to: '/flyxa-ai/ask',                    end: false },
];

export default function FlyxaNav() {
  return (
    <aside
      className="min-h-0 overflow-y-auto border-r px-2 py-4"
      style={{ backgroundColor: colors.d1, borderColor: colors.b0 }}
    >
      <div className="px-2">
        <p className="text-[14px] font-bold tracking-[0.1em]" style={{ color: colors.t0 }}>FLYXA</p>
        <p className="mt-0.5 text-[9.5px]" style={{ color: colors.t2 }}>Trading Intelligence</p>
      </div>

      <nav className="mt-4 space-y-0.5">
        {NAV_ITEMS.map(item => (
          <NavLink key={item.key} to={item.to} end={item.end}>
            {({ isActive }) => (
              <span
                className="block border-l-2 px-2.5 py-2 text-[12.5px] transition-colors hover:bg-white/[0.04]"
                style={{
                  borderLeftColor: isActive ? colors.acc : 'transparent',
                  backgroundColor: isActive ? 'rgba(245,158,11,0.07)' : 'transparent',
                  color: isActive ? colors.acc : colors.t1,
                }}
              >
                {item.label}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
