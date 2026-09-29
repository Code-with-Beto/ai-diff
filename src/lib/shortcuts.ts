export const modifierLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

let singleKeyShortcutsEnabled = true;
const singleKeyListeners = new Set<() => void>();

export function areSingleKeyShortcutsEnabled(): boolean {
  return singleKeyShortcutsEnabled;
}

// Keep this accessibility choice in memory for the current page only.
export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  if (singleKeyShortcutsEnabled === enabled) return;
  singleKeyShortcutsEnabled = enabled;
  singleKeyListeners.forEach(listener => listener());
}

export function subscribeToSingleKeyShortcuts(listener: () => void): () => void {
  singleKeyListeners.add(listener);
  return () => { singleKeyListeners.delete(listener); };
}

export function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]');
}
