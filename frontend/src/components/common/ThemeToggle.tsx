import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext.js';

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === 'light';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle-button ${compact ? 'theme-toggle-button--compact' : ''}`}
      aria-label={`Switch to ${isLight ? 'dark' : 'light'} mode`}
      title={`Switch to ${isLight ? 'dark' : 'light'} mode`}
    >
      {isLight ? <Moon size={16} /> : <Sun size={16} />}
      {!compact && <span>{isLight ? 'Dark mode' : 'Light mode'}</span>}
    </button>
  );
}
