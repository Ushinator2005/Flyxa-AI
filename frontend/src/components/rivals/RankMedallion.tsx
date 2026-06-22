import React from 'react';

export type RankTier = 'bronze' | 'silver' | 'gold' | 'diamond' | 'master' | 'grandmaster';

export const RANK_XP_THRESHOLDS: Record<RankTier, number> = {
  bronze:      0,
  silver:    150,
  gold:      400,
  diamond:   800,
  master:   1500,
  grandmaster: 3000,
};

export const RANK_LABELS: Record<RankTier, string> = {
  bronze:      'Bronze',
  silver:      'Silver',
  gold:        'Gold',
  diamond:     'Diamond',
  master:      'Master',
  grandmaster: 'Grandmaster',
};

export const RANK_COLORS: Record<RankTier, string> = {
  bronze:      '#CD7F32',
  silver:      '#C0C0C0',
  gold:        '#FFD700',
  diamond:     '#00D4FF',
  master:      '#CC2255',
  grandmaster: '#AA44FF',
};

const TIERS = Object.keys(RANK_XP_THRESHOLDS) as RankTier[];

export function getRankFromXP(xp: number): RankTier {
  let rank: RankTier = 'bronze';
  for (const tier of TIERS) {
    if (xp >= RANK_XP_THRESHOLDS[tier]) rank = tier;
  }
  return rank;
}

export function getXPProgress(xp: number): { rank: RankTier; next: RankTier | null; pct: number; xpInRank: number; xpToNext: number } {
  const rank = getRankFromXP(xp);
  const idx = TIERS.indexOf(rank);
  const next = idx < TIERS.length - 1 ? TIERS[idx + 1] : null;
  const current = RANK_XP_THRESHOLDS[rank];
  const nextThreshold = next ? RANK_XP_THRESHOLDS[next] : current;
  const xpInRank = xp - current;
  const xpToNext = next ? nextThreshold - xp : 0;
  const pct = next ? Math.min(100, (xpInRank / (nextThreshold - current)) * 100) : 100;
  return { rank, next, pct, xpInRank, xpToNext };
}

interface MP { size: number }

// ─── BRONZE ──────────────────────────────────────────────────────────────────
function BronzeMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  const beads = Array.from({ length: 20 }, (_, i) => {
    const a = (i / 20) * Math.PI * 2 - Math.PI / 2;
    return <circle key={i} cx={50 + 40 * Math.cos(a)} cy={50 + 40 * Math.sin(a)} r="1.7" fill={`#7A3E0A`} />;
  });
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-label="Bronze">
      <defs>
        <radialGradient id={`${u}a`} cx="38%" cy="30%" r="72%">
          <stop offset="0%"   stopColor="#F8D080" />
          <stop offset="40%"  stopColor="#CD7F32" />
          <stop offset="80%"  stopColor="#96530F" />
          <stop offset="100%" stopColor="#5C2800" />
        </radialGradient>
        <radialGradient id={`${u}b`} cx="38%" cy="30%" r="68%">
          <stop offset="0%"   stopColor="#EAB060" />
          <stop offset="55%"  stopColor="#B06820" />
          <stop offset="100%" stopColor="#6B3A0A" />
        </radialGradient>
        <linearGradient id={`${u}sw`} x1="30%" y1="0%" x2="70%" y2="100%">
          <stop offset="0%"   stopColor="#F8D888" />
          <stop offset="100%" stopColor="#C07820" />
        </linearGradient>
        <filter id={`${u}f`}>
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#3D1500" floodOpacity="0.75" />
        </filter>
      </defs>

      {/* Disc */}
      <circle cx="50" cy="50" r="47" fill={`url(#${u}a)`} filter={`url(#${u}f)`} />
      <circle cx="50" cy="50" r="47" fill="none" stroke="#5C2800" strokeWidth="1.5" />
      <circle cx="50" cy="50" r="43" fill="none" stroke="#F0C068" strokeWidth="0.5" opacity="0.4" />

      {/* Bead ring */}
      {beads}

      {/* Inner circle */}
      <circle cx="50" cy="50" r="34" fill={`url(#${u}b)`} />
      <circle cx="50" cy="50" r="34" fill="none" stroke="#5C2800" strokeWidth="0.8" />

      {/* Gladius (Roman short sword) */}
      <path d="M 48,24 L 50,21 L 52,24 L 52.5,43 L 51,58 L 50,61 L 49,58 L 47.5,43 Z"
        fill={`url(#${u}sw)`} stroke="#7A3E0A" strokeWidth="0.7" />
      {/* Cross-guard */}
      <path d="M 41,41 L 59,41 L 58,45 L 42,45 Z"
        fill={`url(#${u}sw)`} stroke="#7A3E0A" strokeWidth="0.7" />
      {/* Grip wrap */}
      <rect x="47.5" y="57" width="5" height="8" rx="1.5" fill="#C07820" stroke="#7A3E0A" strokeWidth="0.6" />
      {/* Pommel */}
      <ellipse cx="50" cy="70" rx="4.5" ry="3.5" fill={`url(#${u}sw)`} stroke="#7A3E0A" strokeWidth="0.7" />

      {/* Highlight gloss */}
      <ellipse cx="40" cy="34" rx="8" ry="4.5" fill="white" opacity="0.14" transform="rotate(-25 40 34)" />
    </svg>
  );
}

// ─── SILVER ──────────────────────────────────────────────────────────────────
function SilverMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  const hex = (r: number, rot = -90) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = ((rot + i * 60) * Math.PI) / 180;
      return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`;
    }).join(' ');
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-label="Silver">
      <defs>
        <linearGradient id={`${u}a`} x1="20%" y1="5%" x2="80%" y2="100%">
          <stop offset="0%"   stopColor="#F4F4F4" />
          <stop offset="38%"  stopColor="#C8C8C8" />
          <stop offset="78%"  stopColor="#787878" />
          <stop offset="100%" stopColor="#353535" />
        </linearGradient>
        <radialGradient id={`${u}b`} cx="38%" cy="30%" r="65%">
          <stop offset="0%"   stopColor="#FFFFFF" />
          <stop offset="50%"  stopColor="#B8B8B8" />
          <stop offset="100%" stopColor="#585858" />
        </radialGradient>
        <linearGradient id={`${u}st`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#909090" />
        </linearGradient>
        <filter id={`${u}f`}>
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000000" floodOpacity="0.5" />
        </filter>
      </defs>

      {/* Outer hexagon */}
      <polygon points={hex(47)} fill={`url(#${u}a)`} filter={`url(#${u}f)`} />
      <polygon points={hex(47)} fill="none" stroke="#282828" strokeWidth="1.5" />
      <polygon points={hex(43.5)} fill="none" stroke="#D8D8D8" strokeWidth="0.5" opacity="0.45" />

      {/* Inner hex rotated 30° */}
      <polygon points={hex(35, -60)} fill={`url(#${u}b)`} />
      <polygon points={hex(35, -60)} fill="none" stroke="#404040" strokeWidth="0.8" />

      {/* 8-point compass star */}
      <polygon points="50,23 52.5,48 50,73 47.5,48"    fill={`url(#${u}st)`} stroke="#505050" strokeWidth="0.4" />
      <polygon points="77,50 52,52.5 23,50 52,47.5"    fill={`url(#${u}st)`} stroke="#505050" strokeWidth="0.4" />
      <polygon points="69,31 52.5,47.5 31,69 47.5,52.5" fill={`url(#${u}st)`} stroke="#505050" strokeWidth="0.4" opacity="0.75" />
      <polygon points="31,31 47.5,47.5 69,69 52.5,52.5" fill={`url(#${u}st)`} stroke="#505050" strokeWidth="0.4" opacity="0.75" />

      {/* Centre jewel */}
      <circle cx="50" cy="50" r="5.5" fill="white" stroke="#707070" strokeWidth="0.8" />
      <circle cx="50" cy="50" r="2.5" fill="#C0C0C0" />

      {/* Gloss */}
      <ellipse cx="38" cy="32" rx="9" ry="5.5" fill="white" opacity="0.22" transform="rotate(-20 38 32)" />
    </svg>
  );
}

// ─── GOLD ─────────────────────────────────────────────────────────────────────
function GoldMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  const rays = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 47 : 37;
    return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`;
  }).join(' ');
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-label="Gold">
      <defs>
        <radialGradient id={`${u}a`} cx="38%" cy="30%" r="72%">
          <stop offset="0%"   stopColor="#FFF2A8" />
          <stop offset="35%"  stopColor="#FFD700" />
          <stop offset="75%"  stopColor="#DAA520" />
          <stop offset="100%" stopColor="#8B6914" />
        </radialGradient>
        <radialGradient id={`${u}b`} cx="38%" cy="30%" r="66%">
          <stop offset="0%"   stopColor="#FFFACD" />
          <stop offset="45%"  stopColor="#FFD700" />
          <stop offset="100%" stopColor="#B8860B" />
        </radialGradient>
        <linearGradient id={`${u}c`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FFFACD" />
          <stop offset="100%" stopColor="#DAA520" />
        </linearGradient>
        <filter id={`${u}f`}>
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#8B6914" floodOpacity="0.7" />
          <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#FFD700" floodOpacity="0.28" />
        </filter>
      </defs>

      {/* Sun-ray burst */}
      <polygon points={rays} fill={`url(#${u}a)`} filter={`url(#${u}f)`} />

      {/* Inner disc */}
      <circle cx="50" cy="50" r="35" fill={`url(#${u}b)`} />
      <circle cx="50" cy="50" r="35" fill="none" stroke="#8B6914" strokeWidth="1.2" />
      <circle cx="50" cy="50" r="31" fill="none" stroke="#FFD700" strokeWidth="0.5" opacity="0.45" />

      {/* 3-prong crown */}
      <path d="M 34,60 L 34,56 L 38,56 L 38,44 L 41,44 L 41,56 L 46,56 L 50,37 L 54,56 L 59,56 L 59,44 L 62,44 L 62,56 L 66,56 L 66,60 Z"
        fill={`url(#${u}c)`} stroke="#8B6914" strokeWidth="0.8" />
      {/* Crown base */}
      <rect x="33" y="59" width="34" height="6" rx="2" fill={`url(#${u}c)`} stroke="#8B6914" strokeWidth="0.7" />

      {/* Gems on crown */}
      <circle cx="50" cy="47" r="3.2" fill="#FF6600" stroke="#8B6914" strokeWidth="0.7" />
      <circle cx="50" cy="47" r="1.5" fill="#FFAA44" />
      <circle cx="38.5" cy="50" r="2.2" fill="#CC4400" stroke="#8B6914" strokeWidth="0.5" />
      <circle cx="61.5" cy="50" r="2.2" fill="#CC4400" stroke="#8B6914" strokeWidth="0.5" />

      {/* Gloss */}
      <ellipse cx="40" cy="36" rx="8" ry="5" fill="white" opacity="0.2" transform="rotate(-20 40 36)" />
    </svg>
  );
}

// ─── DIAMOND ──────────────────────────────────────────────────────────────────
function DiamondMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  // Gem shape: wide crown, pointed pavilion
  const shape = "50,7 87,44 50,93 13,44";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-label="Diamond">
      <defs>
        <linearGradient id={`${u}a`} x1="20%" y1="0%" x2="80%" y2="100%">
          <stop offset="0%"   stopColor="#E8FBFF" />
          <stop offset="30%"  stopColor="#00D4FF" />
          <stop offset="70%"  stopColor="#0088CC" />
          <stop offset="100%" stopColor="#003366" />
        </linearGradient>
        {/* Facet colour variants for depth */}
        <linearGradient id={`${u}f1`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#004488" />
          <stop offset="50%"  stopColor="#00AAEE" />
          <stop offset="100%" stopColor="#004488" />
        </linearGradient>
        <linearGradient id={`${u}f2`} x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#80EEFF" />
          <stop offset="100%" stopColor="#0066AA" />
        </linearGradient>
        <linearGradient id={`${u}f3`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#0066AA" />
          <stop offset="100%" stopColor="#80EEFF" />
        </linearGradient>
        <filter id={`${u}glow`}>
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#003366" floodOpacity="0.7" />
          <feDropShadow dx="0" dy="0" stdDeviation="9" floodColor="#00D4FF" floodOpacity="0.45" />
        </filter>
        <clipPath id={`${u}clip`}>
          <polygon points={shape} />
        </clipPath>
      </defs>

      {/* Main gem */}
      <polygon points={shape} fill={`url(#${u}a)`} filter={`url(#${u}glow)`} />

      {/* Facet shading layers */}
      <polygon points="50,7 32,26 50,44"  fill={`url(#${u}f1)`} opacity="0.38" clipPath={`url(#${u}clip)`} />
      <polygon points="50,7 68,26 50,44"  fill={`url(#${u}f2)`} opacity="0.38" clipPath={`url(#${u}clip)`} />
      <polygon points="13,44 50,93 30,68" fill={`url(#${u}f3)`} opacity="0.32" clipPath={`url(#${u}clip)`} />
      <polygon points="87,44 50,93 70,68" fill={`url(#${u}f1)`} opacity="0.32" clipPath={`url(#${u}clip)`} />

      {/* Facet lines */}
      <line x1="50" y1="7"  x2="50" y2="44" stroke="#9EEFFF" strokeWidth="0.7" opacity="0.65" clipPath={`url(#${u}clip)`} />
      <line x1="13" y1="44" x2="87" y2="44" stroke="#9EEFFF" strokeWidth="0.7" opacity="0.65" clipPath={`url(#${u}clip)`} />
      <line x1="50" y1="44" x2="50" y2="93" stroke="#9EEFFF" strokeWidth="0.9" opacity="0.6" clipPath={`url(#${u}clip)`} />
      <line x1="32" y1="26" x2="50" y2="44" stroke="#9EEFFF" strokeWidth="0.5" opacity="0.5" clipPath={`url(#${u}clip)`} />
      <line x1="68" y1="26" x2="50" y2="44" stroke="#9EEFFF" strokeWidth="0.5" opacity="0.5" clipPath={`url(#${u}clip)`} />
      <line x1="13" y1="44" x2="50" y2="93" stroke="#9EEFFF" strokeWidth="0.5" opacity="0.4" clipPath={`url(#${u}clip)`} />
      <line x1="87" y1="44" x2="50" y2="93" stroke="#9EEFFF" strokeWidth="0.5" opacity="0.4" clipPath={`url(#${u}clip)`} />
      <line x1="30" y1="68" x2="50" y2="44" stroke="#9EEFFF" strokeWidth="0.4" opacity="0.4" clipPath={`url(#${u}clip)`} />
      <line x1="70" y1="68" x2="50" y2="44" stroke="#9EEFFF" strokeWidth="0.4" opacity="0.4" clipPath={`url(#${u}clip)`} />

      {/* Rim */}
      <polygon points={shape} fill="none" stroke="#9EEFFF" strokeWidth="1.5" opacity="0.85" />

      {/* Girdle flash */}
      <ellipse cx="50" cy="44" rx="9" ry="4.5" fill="white" opacity="0.45" />

      {/* Table top highlight */}
      <polygon points="50,7 38,28 62,28" fill="white" opacity="0.18" clipPath={`url(#${u}clip)`} />

      {/* Sparkle stars */}
      {([
        [50, 5, 0.95], [89, 42, 0.75], [11, 42, 0.75], [50, 95, 0.55],
      ] as [number, number, number][]).map(([x, y, op], i) => (
        <path key={i}
          d={`M${x},${y - 4} L${x + 1.2},${y - 0.5} L${x + 4.5},${y} L${x + 1.2},${y + 0.5} L${x},${y + 4} L${x - 1.2},${y + 0.5} L${x - 4.5},${y} L${x - 1.2},${y - 0.5} Z`}
          fill="white" opacity={op} />
      ))}
    </svg>
  );
}

// ─── MASTER ───────────────────────────────────────────────────────────────────
function MasterMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ display: 'block' }} aria-label="Master">
      <defs>
        <radialGradient id={`${u}sh`} cx="38%" cy="28%" r="72%">
          <stop offset="0%"   stopColor="#4A0028" />
          <stop offset="40%"  stopColor="#2D004C" />
          <stop offset="78%"  stopColor="#180018" />
          <stop offset="100%" stopColor="#080008" />
        </radialGradient>
        <radialGradient id={`${u}si`} cx="38%" cy="28%" r="66%">
          <stop offset="0%"   stopColor="#7B0038" />
          <stop offset="50%"  stopColor="#480058" />
          <stop offset="100%" stopColor="#1E0020" />
        </radialGradient>
        <linearGradient id={`${u}gd`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FFFACD" />
          <stop offset="50%"  stopColor="#FFD700" />
          <stop offset="100%" stopColor="#B8860B" />
        </linearGradient>
        <linearGradient id={`${u}wg`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#3D001A" />
          <stop offset="60%"  stopColor="#18000E" />
          <stop offset="100%" stopColor="#080005" />
        </linearGradient>
        <filter id={`${u}f`}>
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#880000" floodOpacity="0.55" />
          <feDropShadow dx="0" dy="0" stdDeviation="9" floodColor="#CC0033" floodOpacity="0.28" />
        </filter>
        <filter id={`${u}gf`}>
          <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#FFD700" floodOpacity="0.65" />
        </filter>
      </defs>

      {/* Left wing */}
      <path d="M 21,46 Q 3,28 5,54 Q 2,70 14,66 Q 5,76 13,78 Q 21,67 23,59 Z"
        fill={`url(#${u}wg)`} stroke="#8B0000" strokeWidth="0.9" />
      <path d="M 21,46 Q 7,43 5,54" fill="none" stroke="#7B003C" strokeWidth="0.6" opacity="0.7" />
      <path d="M 21,52 Q 5,58 5,54" fill="none" stroke="#7B003C" strokeWidth="0.5" opacity="0.55" />
      <path d="M 21,58 Q 7,68 13,78" fill="none" stroke="#7B003C" strokeWidth="0.5" opacity="0.55" />
      <circle cx="4" cy="55" r="2" fill="#FFD700" opacity="0.65" />

      {/* Right wing (mirror) */}
      <path d="M 79,46 Q 97,28 95,54 Q 98,70 86,66 Q 95,76 87,78 Q 79,67 77,59 Z"
        fill={`url(#${u}wg)`} stroke="#8B0000" strokeWidth="0.9" />
      <path d="M 79,46 Q 93,43 95,54" fill="none" stroke="#7B003C" strokeWidth="0.6" opacity="0.7" />
      <path d="M 79,52 Q 95,58 95,54" fill="none" stroke="#7B003C" strokeWidth="0.5" opacity="0.55" />
      <path d="M 79,58 Q 93,68 87,78" fill="none" stroke="#7B003C" strokeWidth="0.5" opacity="0.55" />
      <circle cx="96" cy="55" r="2" fill="#FFD700" opacity="0.65" />

      {/* Main shield */}
      <path d="M 23,18 L 77,18 L 77,58 Q 77,82 50,91 Q 23,82 23,58 Z"
        fill={`url(#${u}sh)`} filter={`url(#${u}f)`} />
      <path d="M 23,18 L 77,18 L 77,58 Q 77,82 50,91 Q 23,82 23,58 Z"
        fill="none" stroke="#8B0000" strokeWidth="1.6" />

      {/* Inner shield field */}
      <path d="M 28,23 L 72,23 L 72,57 Q 72,78 50,87 Q 28,78 28,57 Z"
        fill={`url(#${u}si)`} />
      <path d="M 28,23 L 72,23 L 72,57 Q 72,78 50,87 Q 28,78 28,57 Z"
        fill="none" stroke="#7B003C" strokeWidth="0.7" opacity="0.55" />

      {/* Crown atop shield */}
      <path d="M 36,25 L 36,21 L 39,21 L 39,15 L 41.5,15 L 41.5,21 L 46,21 L 50,12 L 54,21 L 58.5,21 L 58.5,15 L 61,15 L 61,21 L 64,21 L 64,25 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.8" filter={`url(#${u}gf)`} />
      <rect x="35" y="24" width="30" height="4.5" rx="1.5" fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.7" />
      <circle cx="50" cy="17" r="2.8" fill="#CC0044" stroke="#8B6914" strokeWidth="0.6" />
      <circle cx="50" cy="17" r="1.3" fill="#FF4477" />
      <circle cx="39" cy="20" r="2" fill="#8800CC" stroke="#8B6914" strokeWidth="0.5" />
      <circle cx="61" cy="20" r="2" fill="#8800CC" stroke="#8B6914" strokeWidth="0.5" />

      {/* Crossed swords on shield */}
      {/* Sword / */}
      <path d="M 35,68 L 37,65 L 58,40 L 61,40 L 63,37 L 61,37 L 62,35 L 60,37 L 60,35 L 58,37 L 58,40 L 41,65 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.6" />
      {/* Sword \ */}
      <path d="M 65,68 L 63,65 L 42,40 L 39,40 L 37,37 L 39,37 L 38,35 L 40,37 L 40,35 L 42,37 L 42,40 L 59,65 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.6" />

      {/* Centre gem */}
      <circle cx="50" cy="51" r="5.5" fill="#1A0028" stroke={`url(#${u}gd)`} strokeWidth="1.2" />
      <circle cx="50" cy="51" r="3.5" fill="#CC0044" />
      <circle cx="48.5" cy="49.5" r="1.2" fill="white" opacity="0.55" />

      {/* Flame wisps at shield base */}
      <path d="M 44,89 Q 40,82 44,76 Q 46,84 50,87" fill="#FF4500" opacity="0.55" />
      <path d="M 56,89 Q 60,82 56,76 Q 54,84 50,87" fill="#FF4500" opacity="0.55" />
      <path d="M 50,90 Q 48,83 50,77 Q 52,83 50,90" fill="#FF6600" opacity="0.45" />

      {/* Gloss */}
      <ellipse cx="40" cy="30" rx="9" ry="5" fill="white" opacity="0.1" transform="rotate(-15 40 30)" />
    </svg>
  );
}

// ─── GRANDMASTER ──────────────────────────────────────────────────────────────
function GrandmasterMedallion({ size }: MP) {
  const u = React.useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 110 115" width={size} height={size * (115 / 110)} style={{ display: 'block' }} aria-label="Grandmaster">
      <defs>
        {/* Animated rainbow gradient */}
        <linearGradient id={`${u}rim`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%">
            <animate attributeName="stop-color"
              values="#FF0044;#FF8800;#FFEE00;#00FF88;#0088FF;#AA00FF;#FF0044"
              dur="4s" repeatCount="indefinite" />
          </stop>
          <stop offset="50%">
            <animate attributeName="stop-color"
              values="#AA00FF;#FF0044;#FF8800;#FFEE00;#00FF88;#0088FF;#AA00FF"
              dur="4s" repeatCount="indefinite" />
          </stop>
          <stop offset="100%">
            <animate attributeName="stop-color"
              values="#0088FF;#AA00FF;#FF0044;#FF8800;#FFEE00;#00FF88;#0088FF"
              dur="4s" repeatCount="indefinite" />
          </stop>
        </linearGradient>

        <radialGradient id={`${u}bg`} cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#1E0035" />
          <stop offset="60%"  stopColor="#0E0018" />
          <stop offset="100%" stopColor="#050008" />
        </radialGradient>
        <radialGradient id={`${u}in`} cx="38%" cy="28%" r="66%">
          <stop offset="0%"   stopColor="#2C0048" />
          <stop offset="52%"  stopColor="#180028" />
          <stop offset="100%" stopColor="#080010" />
        </radialGradient>
        <linearGradient id={`${u}gd`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%"   stopColor="#FFFACD" />
          <stop offset="50%"  stopColor="#FFD700" />
          <stop offset="100%" stopColor="#B8860B" />
        </linearGradient>
        <linearGradient id={`${u}wg`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#20002E" />
          <stop offset="100%" stopColor="#0A0010" />
        </linearGradient>
        <filter id={`${u}f`}>
          <feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#220033" floodOpacity="0.85" />
          <feDropShadow dx="0" dy="0" stdDeviation="12" floodColor="#AA00FF" floodOpacity="0.35" />
        </filter>
        <filter id={`${u}gf`}>
          <feDropShadow dx="0" dy="0" stdDeviation="2.5" floodColor="#FFD700" floodOpacity="0.7" />
        </filter>
        <filter id={`${u}sf`}>
          <feGaussianBlur stdDeviation="1.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {/* Clip to crest shape */}
        <clipPath id={`${u}cl`}>
          <path d="M 55,4 L 70,14 L 82,9 L 77,22 L 95,24 L 95,78 Q 95,100 55,110 Q 15,100 15,78 L 15,24 L 33,22 L 28,9 L 40,14 Z" />
        </clipPath>
      </defs>

      {/* Dragon wings */}
      {/* Left wing */}
      <path d="M 16,48 Q -4,22 2,52 Q -2,74 12,70 Q 3,82 12,84 Q 20,71 22,62 Z"
        fill={`url(#${u}wg)`} stroke={`url(#${u}rim)`} strokeWidth="1.2" />
      <path d="M 16,48 Q 3,44 2,52" fill="none" stroke="#440066" strokeWidth="0.7" opacity="0.7" />
      <path d="M 16,55 Q 2,60 2,52" fill="none" stroke="#440066" strokeWidth="0.5" opacity="0.55" />
      <path d="M 16,62 Q 4,72 12,84" fill="none" stroke="#440066" strokeWidth="0.5" opacity="0.55" />

      {/* Right wing */}
      <path d="M 94,48 Q 114,22 108,52 Q 112,74 98,70 Q 107,82 98,84 Q 90,71 88,62 Z"
        fill={`url(#${u}wg)`} stroke={`url(#${u}rim)`} strokeWidth="1.2" />
      <path d="M 94,48 Q 107,44 108,52" fill="none" stroke="#440066" strokeWidth="0.7" opacity="0.7" />
      <path d="M 94,55 Q 108,60 108,52" fill="none" stroke="#440066" strokeWidth="0.5" opacity="0.55" />
      <path d="M 94,62 Q 106,72 98,84" fill="none" stroke="#440066" strokeWidth="0.5" opacity="0.55" />

      {/* Main crest body */}
      <path d="M 55,4 L 70,14 L 82,9 L 77,22 L 95,24 L 95,78 Q 95,100 55,110 Q 15,100 15,78 L 15,24 L 33,22 L 28,9 L 40,14 Z"
        fill={`url(#${u}bg)`} filter={`url(#${u}f)`} />

      {/* Rainbow animated rim */}
      <path d="M 55,4 L 70,14 L 82,9 L 77,22 L 95,24 L 95,78 Q 95,100 55,110 Q 15,100 15,78 L 15,24 L 33,22 L 28,9 L 40,14 Z"
        fill="none" stroke={`url(#${u}rim)`} strokeWidth="2.8" />

      {/* Inner field */}
      <path d="M 55,11 L 67,19 L 76,15 L 72,25 L 87,27 L 87,76 Q 87,95 55,104 Q 23,95 23,76 L 23,27 L 38,25 L 34,15 L 43,19 Z"
        fill={`url(#${u}in)`} />
      <path d="M 55,11 L 67,19 L 76,15 L 72,25 L 87,27 L 87,76 Q 87,95 55,104 Q 23,95 23,76 L 23,27 L 38,25 L 34,15 L 43,19 Z"
        fill="none" stroke="#440066" strokeWidth="0.8" opacity="0.55" />

      {/* 5-prong crown at top */}
      <path d="M 38,28 L 38,24 L 41,24 L 41,17 L 43.5,17 L 43.5,23 L 47,23 L 47,14 L 49.5,14 L 49.5,23 L 55,6 L 60.5,23 L 60.5,14 L 63,14 L 63,23 L 66.5,23 L 66.5,17 L 69,17 L 69,24 L 72,24 L 72,28 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.8" filter={`url(#${u}gf)`} />
      <rect x="37" y="27" width="36" height="5" rx="2" fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.7" />

      {/* Crown gems */}
      <circle cx="55" cy="12" r="3.5" fill="#FF00AA" stroke="#8B6914" strokeWidth="0.7" />
      <circle cx="55" cy="12" r="1.8" fill="#FF88DD" />
      <circle cx="43" cy="19" r="2.2" fill="#8800FF" stroke="#8B6914" strokeWidth="0.5" />
      <circle cx="67" cy="19" r="2.2" fill="#8800FF" stroke="#8B6914" strokeWidth="0.5" />
      <circle cx="48.5" cy="16" r="1.8" fill="#FF4400" stroke="#8B6914" strokeWidth="0.4" />
      <circle cx="61.5" cy="16" r="1.8" fill="#FF4400" stroke="#8B6914" strokeWidth="0.4" />

      {/* Background star constellation */}
      {([
        [30,38,0.45], [80,38,0.45], [28,62,0.35], [82,62,0.35], [40,50,0.3], [70,50,0.3],
      ] as [number,number,number][]).map(([x,y,op],i) => (
        <path key={i} filter={`url(#${u}sf)`}
          d={`M${x},${y-3.5} L${x+1},${y-0.5} L${x+4},${y} L${x+1},${y+0.5} L${x},${y+3.5} L${x-1},${y+0.5} L${x-4},${y} L${x-1},${y-0.5} Z`}
          fill="#FFD700" opacity={op} />
      ))}

      {/* Dragon eye / centre gem */}
      <circle cx="55" cy="62" r="14" fill="#0E0018" stroke={`url(#${u}rim)`} strokeWidth="1.8" />
      <circle cx="55" cy="62" r="10" fill="none" stroke="#440066" strokeWidth="0.5" opacity="0.5" />
      {/* Iris */}
      <ellipse cx="55" cy="62" rx="8" ry="11" fill="#6600AA" />
      <ellipse cx="55" cy="62" rx="3.5" ry="9" fill="#1A0030" />
      <ellipse cx="55" cy="62" rx="1.5" ry="8" fill="#0E0018" />
      {/* Eye shine */}
      <ellipse cx="52.5" cy="57" rx="2.5" ry="1.8" fill="white" opacity="0.5" transform="rotate(-20 52.5 57)" />
      <circle cx="57" cy="58.5" r="0.9" fill="white" opacity="0.4" />

      {/* Crossed swords below eye */}
      <path d="M 34,88 L 36,85 L 57,58 L 60,58 L 62,55 L 60,55 L 61,53 L 59,55 L 59,53 L 57,55 L 57,58 L 40,85 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.6" />
      <path d="M 76,88 L 74,85 L 53,58 L 50,58 L 48,55 L 50,55 L 49,53 L 51,55 L 51,53 L 53,55 L 53,58 L 70,85 Z"
        fill={`url(#${u}gd)`} stroke="#8B6914" strokeWidth="0.6" />

      {/* Corner sparkles */}
      {([
        [55,3,1.0],[15,24,0.75],[95,24,0.75],[15,78,0.65],[95,78,0.65],[55,111,0.6],
      ] as [number,number,number][]).map(([x,y,op],i) => (
        <path key={i} filter={`url(#${u}sf)`}
          d={`M${x},${y-5} L${x+1.5},${y-0.8} L${x+5.5},${y} L${x+1.5},${y+0.8} L${x},${y+5} L${x-1.5},${y+0.8} L${x-5.5},${y} L${x-1.5},${y-0.8} Z`}
          fill="white" opacity={op} />
      ))}

      {/* Gloss */}
      <ellipse cx="43" cy="38" rx="11" ry="6" fill="white" opacity="0.07" transform="rotate(-15 43 38)" />
    </svg>
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────
interface Props {
  rank: RankTier;
  size?: number;
}

export default function RankMedallion({ rank, size = 48 }: Props) {
  switch (rank) {
    case 'bronze':      return <BronzeMedallion size={size} />;
    case 'silver':      return <SilverMedallion size={size} />;
    case 'gold':        return <GoldMedallion size={size} />;
    case 'diamond':     return <DiamondMedallion size={size} />;
    case 'master':      return <MasterMedallion size={size} />;
    case 'grandmaster': return <GrandmasterMedallion size={size} />;
  }
}
