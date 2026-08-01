interface FlyxaLogoProps {
  size?: number;
  showWordmark?: boolean;
  mode?: 'compact' | 'banner';
  subtitle?: string;
  className?: string;
  wordmarkClassName?: string;
  subtitleClassName?: string;
}

// The Flyxa mark: four petals in a pinwheel around an open center, the
// top-right petal in brand orange. Petals use the theme text color so the
// mark adapts to dark/light backgrounds.
const PETAL_PATH = 'M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z';
const ORANGE = '#F97316';

function petalTransform(rotation: number, scale: number): string {
  const offset = 50 * (1 - scale);
  return `rotate(${rotation} 50 50) translate(${offset} ${offset}) scale(${scale})`;
}

function FlyxaMark({ petal }: { petal: string }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" className="h-full w-full" aria-hidden="true">
      {/* top-right — brand orange, largest */}
      <path d={PETAL_PATH} fill={ORANGE} transform={petalTransform(0, 1)} />
      {/* top-left */}
      <path d={PETAL_PATH} fill={petal} transform={petalTransform(-90, 0.82)} />
      {/* bottom-right */}
      <path d={PETAL_PATH} fill={petal} transform={petalTransform(90, 0.88)} />
      {/* bottom-left — smallest */}
      <path d={PETAL_PATH} fill={petal} transform={petalTransform(180, 0.64)} />
    </svg>
  );
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
    petal: 'var(--app-text)',
    word: 'var(--app-text)',
    subtitle: 'var(--app-text-subtle)',
  };

  const mark = <FlyxaMark petal={palette.petal} />;

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
          <div className={`text-xl leading-none tracking-[-0.02em] ${wordmarkClassName}`.trim()} style={{ color: palette.word, fontFamily: "'Newsreader', Georgia, serif", fontWeight: 400 }}>
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
      <div className="relative flex items-center justify-center gap-4 px-6 py-5">
        <div className="relative shrink-0" style={{ width: Math.max(34, Math.round(size * 0.8)), height: Math.max(34, Math.round(size * 0.8)) }}>
          {mark}
        </div>
        <div className="min-w-0 text-center">
          <div className={`text-xl leading-none tracking-[-0.02em] ${wordmarkClassName}`.trim()} style={{ color: palette.word, fontFamily: "'Newsreader', Georgia, serif", fontWeight: 400 }}>
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
