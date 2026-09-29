import { useEffect, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { getTheme, isThemeShortcut, subscribeToTheme, toggleTheme } from '../lib/theme';

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, () => 'light');
  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  const Icon = theme === 'dark' ? Sun : Moon;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isThemeShortcut(event)) return;
      event.preventDefault();
      toggleTheme();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <button type="button" className="icon-button theme-toggle" onClick={toggleTheme} aria-label={label} aria-keyshortcuts="T" title={`${label} (T)`}>
    <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
  </button>;
}
