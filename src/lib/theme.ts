import { areSingleKeyShortcutsEnabled } from './shortcuts';

export type Theme = 'light' | 'dark';

// The early /theme.js script owns theme persistence and system/storage events.
// React observes its DOM snapshot, so there is no second initialization race.
export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function subscribeToTheme(listener: () => void): () => void {
  window.addEventListener('aidiff:theme-change', listener);
  return () => window.removeEventListener('aidiff:theme-change', listener);
}

export function setTheme(theme: Theme): void {
  window.dispatchEvent(new CustomEvent('aidiff:set-theme', { detail: theme }));
}

export function toggleTheme(): void {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function isThemeShortcut(event: KeyboardEvent): boolean {
  if (!areSingleKeyShortcutsEnabled() || event.key.toLowerCase() !== 't' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing || event.defaultPrevented) return false;
  if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return false;
  const target = event.target;
  return !(target instanceof Element && target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]'));
}
