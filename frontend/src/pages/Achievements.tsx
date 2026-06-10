import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Trophy,
  Flame,
  Zap,
  Crown,
  Shield,
  ShieldCheck,
  Target,
  Award,
  TrendingUp,
  CheckCircle,
  Star,
  Calendar,
  ArrowUpRight,
  Ruler,
  DollarSign,
  Gem,
  Snowflake,
  ClipboardCheck,
  ListChecks,
  PenLine,
  Upload,
  Trash2,
} from 'lucide-react';
import { useAchievements } from '../hooks/useAchievements.js';
import type { Achievement as AchievementItem } from '../hooks/useAchievements.js';
import type { AchievementCategory, AchievementRarity } from '../utils/streaks.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { formatCurrency } from '../utils/calculations.js';
import './Achievements.css';

const ICON_MAP: Record<string, LucideIcon> = {
  Zap,
  Flame,
  Crown,
  Shield,
  ShieldCheck,
  Target,
  Award,
  TrendingUp,
  CheckCircle,
  Star,
  Calendar,
  Trophy,
  Ruler,
  DollarSign,
  Gem,
  Snowflake,
  ClipboardCheck,
  ListChecks,
  PenLine,
};

const CATEGORIES: Array<{ value: AchievementCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'streak', label: 'Streak' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'session', label: 'Session' },
  { value: 'consistency', label: 'Consistency' },
];

const PAYOUT_GALLERY_KEY = 'flyxa_payout_gallery_photos_v1';

type Tone = 'green' | 'blue' | 'purple' | 'amber';
type RarityClass = 'common' | 'rare' | 'epic' | 'legendary';

interface PayoutPhoto {
  id: string;
  src: string;
  name: string;
  createdAt: string;
}

function AchievementIcon({ name, size = 20 }: { name: string; size?: number }) {
  const Icon = ICON_MAP[name] ?? Trophy;
  return <Icon size={size} strokeWidth={1.9} />;
}

function formatUnlockedDate(unlockedAt?: string | null): string | null {
  if (!unlockedAt) return null;
  return new Date(unlockedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getRarityClass(rarity?: AchievementRarity): RarityClass {
  if (rarity === 'rare' || rarity === 'epic' || rarity === 'legendary') return rarity;
  return 'common';
}

function StreakCard({
  label,
  value,
  best,
  icon,
  tone,
  note,
}: {
  label: string;
  value: number;
  best: number;
  icon: ReactNode;
  tone: Tone;
  note: string;
}) {
  const progress = best > 0 ? Math.min(100, Math.round((value / best) * 100)) : value > 0 ? 100 : 0;

  return (
    <article className={`achv-streak-card achv-tone-${tone}`}>
      <header className="achv-streak-head">
        <span className="achv-streak-icon">{icon}</span>
        <span className="achv-streak-label">{label}</span>
      </header>
      <div className="achv-streak-main">
        <p className="achv-streak-value">{value}</p>
        <span className="achv-streak-unit">current</span>
      </div>
      <div className="achv-mini-track" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <p className="achv-streak-meta">
        {note} <span>Best {best}</span>
      </p>
    </article>
  );
}

function NextTargetCard({ achievement }: { achievement: AchievementItem }) {
  const rarityClass = getRarityClass(achievement.rarity as AchievementRarity);
  return (
    <article className={`achv-target-card achv-rarity-${rarityClass}`}>
      <div className="achv-target-icon">
        <AchievementIcon name={achievement.icon} size={18} />
      </div>
      <div className="achv-target-body">
        <div className="achv-target-topline">
          <span>{achievement.category}</span>
          <strong>{Math.round(achievement.progress)}%</strong>
        </div>
        <h3>{achievement.label}</h3>
        <p>{achievement.description}</p>
        <div className="achv-target-track">
          <span style={{ width: `${achievement.progress}%` }} />
        </div>
      </div>
    </article>
  );
}

function AchievementBadge({ achievement }: { achievement: AchievementItem }) {
  const rarityClass = getRarityClass(achievement.rarity as AchievementRarity);
  const unlockedDate = formatUnlockedDate(achievement.unlockedAt);

  return (
    <article className={`achv-badge achv-rarity-${rarityClass} ${achievement.unlocked ? 'is-unlocked' : 'is-locked'}`}>
      <div className="achv-badge-top">
        <div className="achv-badge-icon-wrap">
          <AchievementIcon name={achievement.icon} />
        </div>
        <span className="achv-rarity-pill">{rarityClass}</span>
      </div>
      <h3 className="achv-badge-title">{achievement.label}</h3>
      <p className="achv-badge-desc">{achievement.description}</p>
      <footer className="achv-badge-foot">
        <div className="achv-badge-progress">
          <span style={{ width: `${achievement.progress}%` }} />
        </div>
        <span className="achv-unlocked-date">
          {achievement.unlocked && unlockedDate ? `Unlocked ${unlockedDate}` : `${Math.round(achievement.progress)}% complete`}
        </span>
      </footer>
    </article>
  );
}

function readPayoutPhotos(): PayoutPhoto[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PAYOUT_GALLERY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Partial<PayoutPhoto>;
        if (typeof record.id !== 'string' || typeof record.src !== 'string') return null;
        return {
          id: record.id,
          src: record.src,
          name: typeof record.name === 'string' ? record.name : 'Payout proof',
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        };
      })
      .filter((item): item is PayoutPhoto => item !== null);
  } catch {
    return [];
  }
}

export default function Achievements() {
  const { stats, achievements, unlockedCount, totalCount, loading } = useAchievements();
  const accounts = useFlyxaStore(state => state.accounts);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [payoutPhotos, setPayoutPhotos] = useState<PayoutPhoto[]>(readPayoutPhotos);
  const [category, setCategory] = useState<AchievementCategory | 'all'>('all');
  const [showLocked, setShowLocked] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(PAYOUT_GALLERY_KEY, JSON.stringify(payoutPhotos));
    } catch {
      // Ignore storage quota errors; the in-memory gallery still works for the session.
    }
  }, [payoutPhotos]);

  const visibleAchievements = useMemo(() => {
    const filtered = achievements.filter(achievement => {
      if (category !== 'all' && achievement.category !== category) return false;
      if (!showLocked && !achievement.unlocked) return false;
      return true;
    });

    return [
      ...filtered.filter(achievement => achievement.unlocked),
      ...filtered.filter(achievement => !achievement.unlocked),
    ];
  }, [achievements, category, showLocked]);

  const nextTargets = useMemo(
    () => achievements
      .filter(achievement => !achievement.unlocked)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 3),
    [achievements],
  );

  const progress = totalCount > 0 ? (unlockedCount / totalCount) * 100 : 0;
  const progressLabel = `${Math.round(progress)}%`;

  const focusContent = useMemo(() => {
    const { currentWinStreak, currentDisciplineStreak, currentGreenDayStreak } = stats;
    const d = currentDisciplineStreak;
    const w = currentWinStreak;
    const g = currentGreenDayStreak;

    if (d > 0 && d >= w && d >= g) {
      return {
        heading: `${d} disciplined ${d === 1 ? 'entry' : 'entries'} in a row`,
        body: 'Process is your edge right now. One more clean session extends it — focus on plan adherence, not the P&L.',
        icon: <ShieldCheck size={26} />,
      };
    }
    if (w > 0 && w >= g) {
      return {
        heading: `${w} win run`,
        body: "Execution is clicking. Stay size-appropriate and let the edge play out — don't force entries to keep the streak alive.",
        icon: <Flame size={26} />,
      };
    }
    if (g > 0) {
      return {
        heading: `${g} green ${g === 1 ? 'day' : 'days'} running`,
        body: 'Daily consistency is building. Protect it by sticking to your risk limits — a clean loss beats a blown day.',
        icon: <TrendingUp size={26} />,
      };
    }
    return {
      heading: 'Build the first run',
      body: 'Start with process, not outcome. One session with full plan adherence and a completed journal is the first brick.',
      icon: <Trophy size={26} />,
    };
  }, [stats]);

  const payoutGallery = useMemo(() => {
    const payouts = accounts.flatMap(account => (
      (account.payouts ?? []).map(payout => ({
        ...payout,
        accountName: account.name,
        firm: account.firm,
      }))
    )).sort((a, b) => b.date.localeCompare(a.date));
    const total = payouts.reduce((sum, payout) => sum + Math.max(0, payout.amount), 0);
    return { payouts, total };
  }, [accounts]);
  void focusContent;

  const handlePayoutPhotoUpload = (files: FileList | null) => {
    if (!files?.length) return;
    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/')).slice(0, 8);
    imageFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) return;
        setPayoutPhotos(prev => [
          {
            id: crypto.randomUUID(),
            src,
            name: file.name,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 24));
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <div className="achv-page animate-fade-in">
      <header className="achv-hero">
        <div className="achv-hero-copy">
          <span className="achv-kicker">Performance record</span>
          <h1>Streaks &amp; Achievements</h1>
          <p>
            Process streaks, execution milestones, and earned consistency markers from your trading history.
          </p>
        </div>
        <div className="achv-hero-score">
          <span>Unlocked</span>
          <strong>{unlockedCount}<small>/{totalCount}</small></strong>
          <div className="achv-hero-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p>{progressLabel} complete</p>
        </div>
      </header>

      <section className="achv-focus-grid">
        <article className="achv-payout-gallery">
          <div className="achv-payout-head">
            <div>
              <span className="achv-focus-label">Payout gallery</span>
              <h2>{formatCurrency(payoutGallery.total)}</h2>
              <p>{payoutPhotos.length} photo{payoutPhotos.length === 1 ? '' : 's'} saved. {payoutGallery.payouts.length} payout{payoutGallery.payouts.length === 1 ? '' : 's'} recorded across your accounts.</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="achv-payout-input"
              onChange={event => {
                handlePayoutPhotoUpload(event.target.files);
                event.target.value = '';
              }}
            />
            <button type="button" className="achv-payout-upload" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} />
              Add photos
            </button>
          </div>

          {payoutPhotos.length > 0 ? (
            <div className="achv-payout-photo-grid">
              {payoutPhotos.map(photo => (
                <figure key={photo.id} className="achv-payout-photo">
                  <img src={photo.src} alt={photo.name} />
                  <figcaption>
                    <span>{new Date(photo.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <button
                      type="button"
                      aria-label="Delete payout photo"
                      onClick={() => setPayoutPhotos(prev => prev.filter(item => item.id !== photo.id))}
                    >
                      <Trash2 size={12} />
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="achv-payout-empty">
              <Upload size={18} />
              <div>
                <strong>No payout photos yet</strong>
                <span>Upload screenshots or photos of payouts to build your gallery.</span>
              </div>
            </div>
          )}
        </article>

        <section className="achv-targets" aria-label="Next achievements">
          <div className="achv-section-row">
            <h2 className="achv-section-title">Closest Targets</h2>
            <ArrowUpRight size={14} />
          </div>
          {nextTargets.length > 0 ? (
            nextTargets.map(achievement => <NextTargetCard key={achievement.key} achievement={achievement} />)
          ) : (
            <div className="achv-target-empty">All visible targets are complete.</div>
          )}
        </section>
      </section>

      <section className="achv-section">
        <div className="achv-section-row">
          <h2 className="achv-section-title">Live Streaks</h2>
        </div>
        {loading ? (
          <div className="achv-streak-grid achv-streak-grid-loading">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="achv-skeleton" />
            ))}
          </div>
        ) : (
          <div className="achv-streak-grid">
            <StreakCard
              label="Win streak"
              value={stats.currentWinStreak}
              best={stats.bestWinStreak}
              icon={<Flame size={15} />}
              tone="green"
              note="Outcome momentum"
            />
            <StreakCard
              label="Best run"
              value={stats.bestWinStreak}
              best={stats.bestWinStreak}
              icon={<Zap size={15} />}
              tone="blue"
              note="Peak execution"
            />
            <StreakCard
              label="Discipline"
              value={stats.currentDisciplineStreak}
              best={stats.bestDisciplineStreak}
              icon={<ShieldCheck size={15} />}
              tone="purple"
              note="Plan compliance"
            />
            <StreakCard
              label="Green days"
              value={stats.currentGreenDayStreak}
              best={stats.bestGreenDayStreak}
              icon={<TrendingUp size={15} />}
              tone="amber"
              note="Daily net positive"
            />
          </div>
        )}
      </section>

      <section className="achv-section">
        <div className="achv-toolbar">
          <div>
            <h2 className="achv-section-title">Achievement Board</h2>
            <p className="achv-section-sub">Earned items are listed first. Locked items show current progress.</p>
          </div>
          <button
            type="button"
            className="achv-chip achv-chip-toggle"
            onClick={() => setShowLocked(value => !value)}
          >
            {showLocked ? 'Hide locked' : 'Show locked'}
          </button>
        </div>

        <div className="achv-filters">
          {CATEGORIES.map(option => (
            <button
              key={option.value}
              type="button"
              className={`achv-chip ${category === option.value ? 'is-active' : ''}`}
              onClick={() => setCategory(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="achv-grid">
            {Array.from({ length: 10 }).map((_, index) => (
              <div key={index} className="achv-skeleton achv-skeleton-badge" />
            ))}
          </div>
        ) : visibleAchievements.length === 0 ? (
          <div className="achv-empty">
            <Trophy size={28} />
            <p>No achievements in this category yet.</p>
          </div>
        ) : (
          <div className="achv-grid">
            {visibleAchievements.map(achievement => (
              <AchievementBadge key={achievement.key} achievement={achievement} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
