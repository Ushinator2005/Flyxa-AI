import { Moon, MoonStar, Sun } from 'lucide-react';
import { useTheme, type Theme } from '../../contexts/ThemeContext.js';

// Cycles Default → Light → Midnight. Button shows the mode it switches TO.
const NEXT_LABEL: Record<Theme, string> = {
  dark: 'Light mode',
  light: 'Midnight mode',
  midnight: 'Default mode',
};

function NextIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') return <Sun size={16} />;
  if (theme === 'light') return <MoonStar size={16} />;
  return <Moon size={16} />;
}

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const nextLabel = NEXT_LABEL[theme];

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle-button ${compact ? 'theme-toggle-button--compact' : ''}`}
      aria-label={`Switch to ${nextLabel.toLowerCase()}`}
      title={`Switch to ${nextLabel.toLowerCase()}`}
    >
      <NextIcon theme={theme} />
      {!compact && <span>{nextLabel}</span>}
    </button>
  );
}
