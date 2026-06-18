import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext.js';

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggleTheme } = useTheme();

  const icon = theme === 'rainbow' ? '🌈' : theme === 'light' ? <Moon size={16} /> : <Sun size={16} />;
  const nextLabel = theme === 'dark' ? 'Light mode' : theme === 'light' ? 'Pride mode' : 'Dark mode';
  const ariaLabel = `Switch to ${nextLabel.toLowerCase()}`;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={`theme-toggle-button ${compact ? 'theme-toggle-button--compact' : ''}`}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {typeof icon === 'string' ? <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span> : icon}
      {!compact && <span>{nextLabel}</span>}
    </button>
  );
}
