import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

// 'dark' is the original Flyxa look (warm near-black) — labeled "Default" in
// the UI. 'midnight' is the true-black terminal theme. Only 'light' flips
// component-level styling; midnight inherits every dark style and swaps the
// surface tokens via html[data-theme='midnight'] in tokens.css.
export type Theme = 'dark' | 'light' | 'midnight';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'flyxa-ai-theme';
const LEGACY_STORAGE_KEY = 'tradewise-theme';
const THEME_ORDER: Theme[] = ['dark', 'light', 'midnight'];

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';

  const savedTheme = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (savedTheme === 'dark' || savedTheme === 'light' || savedTheme === 'midnight') {
    return savedTheme;
  }

  return 'dark';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    setTheme,
    toggleTheme: () => setTheme(currentTheme => {
      const index = THEME_ORDER.indexOf(currentTheme);
      return THEME_ORDER[(index + 1) % THEME_ORDER.length];
    }),
  }), [theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
