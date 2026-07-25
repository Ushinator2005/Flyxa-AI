import { NavLink } from 'react-router-dom';

const colors = {
  d0: 'var(--color-bg)',
  d1: 'var(--color-bg-muted)',
  d2: 'var(--color-panel)',
  b0: 'var(--color-border)',
  t0: 'var(--color-text)',
  t1: 'var(--color-text-muted)',
  t2: 'var(--color-text-subtle)',
  acc: 'var(--color-amber)',
};

const NAV_ITEMS = [
  { key: 'weekly',         label: 'Debrief',          hint: 'What changed',       to: '/flyxa-ai',                        end: true  },
  { key: 'weekly-report',  label: 'Report',           hint: 'Shareable recap',    to: '/flyxa-ai/weekly-report',          end: false },
  { key: 'pattern',        label: 'Patterns',         hint: 'Edges and leaks',    to: '/flyxa-ai/patterns',               end: false },
  { key: 'ask',            label: 'Ask',              hint: 'Query your data',    to: '/flyxa-ai/ask',                    end: false },
];

export default function FlyxaNav() {
  return (
    <aside
      className="min-h-0 overflow-y-auto border-r px-3 py-5"
      style={{ backgroundColor: colors.d1, borderColor: colors.b0 }}
    >
      <div className="px-2">
        <p className="text-[13px] font-semibold tracking-[0.08em]" style={{ color: colors.t0 }}>Flyxa AI</p>
        <p className="mt-1 text-[11px] leading-snug" style={{ color: colors.t2 }}>Coaching from your journal</p>
      </div>

      <nav className="mt-5 space-y-1">
        {NAV_ITEMS.map(item => (
          <NavLink key={item.key} to={item.to} end={item.end}>
            {({ isActive }) => (
              <span
                className="block rounded-[8px] border px-3 py-2.5 transition-colors hover:bg-white/[0.04]"
                style={{
                  borderColor: isActive ? 'rgba(245,158,11,0.26)' : 'transparent',
                  backgroundColor: isActive ? 'rgba(245,158,11,0.08)' : 'transparent',
                  color: isActive ? colors.t0 : colors.t1,
                }}
              >
                <span className="block text-[12.5px] font-semibold">{item.label}</span>
                <span className="mt-0.5 block text-[10.5px]" style={{ color: isActive ? colors.t1 : colors.t2 }}>{item.hint}</span>
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6 rounded-[10px] border px-3 py-3" style={{ borderColor: colors.b0, backgroundColor: colors.d2 }}>
        <p className="text-[10px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>How to use this</p>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: colors.t1 }}>
          Read the debrief, choose one fix, then ask a follow-up only if you need context.
        </p>
      </div>
    </aside>
  );
}
