interface FlyxaLogoProps {
  size?: number;
  showWordmark?: boolean;
  mode?: 'compact' | 'banner';
  subtitle?: string;
  className?: string;
  wordmarkClassName?: string;
  subtitleClassName?: string;
}

export default function FlyxaLogo({
  size = 48,
  showWordmark = false,
  mode = 'compact',
  subtitle,
  className = '',
  wordmarkClassName = '',
  subtitleClassName = '',
}: FlyxaLogoProps) {
  const palette = {
    lineDim: 'rgba(245,158,11,0.45)',
    lineBright: '#f59e0b',
    dot: '#f59e0b',
    word: 'var(--app-text)',
    subtitle: 'var(--app-text-subtle)',
  };

  const mark = (
    <svg viewBox="0 0 120 120" fill="none" className="h-full w-full" aria-hidden="true">
      <line x1="6" y1="78" x2="40" y2="78" stroke={palette.lineDim} strokeWidth="3" strokeLinecap="round" />
      <line x1="40" y1="78" x2="72" y2="46" stroke={palette.lineBright} strokeWidth="3.2" strokeLinecap="round" />
      <line x1="72" y1="46" x2="112" y2="46" stroke={palette.lineBright} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="40" cy="78" r="7" fill={palette.dot} />
    </svg>
  );

  if (!showWordmark) {
    return (
      <div className={`relative shrink-0 ${className}`.trim()} style={{ width: size, height: size }}>
        {mark}
      </div>
    );
  }

  if (mode === 'compact') {
    return (
      <div className={`inline-flex flex-col ${className}`.trim()}>
        <div className="flex items-center gap-3">
          <div className="relative shrink-0" style={{ width: size, height: size }}>
            {mark}
          </div>
          <div className={`auth-display text-xl font-light leading-none tracking-[-0.04em] ${wordmarkClassName}`.trim()} style={{ color: palette.word }}>
            Flyxa
          </div>
        </div>
        <div className={`mt-2 w-full text-center text-[10px] uppercase tracking-[0.5em] ${subtitleClassName}`.trim()} style={{ color: palette.subtitle }}>
          {subtitle || 'Trading Intelligence'}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative w-full min-w-0 overflow-hidden ${className}`.trim()}
      style={{ minHeight: Math.max(58, Math.round(size * 1.5)) }}
    >
      <svg viewBox="0 0 860 214" fill="none" className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-hidden="true">
        <line x1="112" y1="126" x2="270" y2="126" stroke={palette.lineDim} strokeWidth="2.4" strokeLinecap="round" />
        <line x1="270" y1="126" x2="355" y2="56" stroke={palette.lineBright} strokeWidth="2.8" />
        <line x1="355" y1="56" x2="850" y2="56" stroke={palette.lineBright} strokeWidth="2.8" strokeLinecap="round" />
        <circle cx="270" cy="126" r="8" fill={palette.dot} />
      </svg>

      <div className="relative flex items-center justify-center px-6 py-5">
        <div className="min-w-0 text-center">
          <div className={`auth-display text-xl font-light leading-none tracking-[-0.04em] ${wordmarkClassName}`.trim()} style={{ color: palette.word }}>
            Flyxa
          </div>
          <div className={`mt-2 text-[10px] uppercase tracking-[0.5em] ${subtitleClassName}`.trim()} style={{ color: palette.subtitle }}>
            {subtitle || 'Trading Intelligence'}
          </div>
        </div>
      </div>
    </div>
  );
}
