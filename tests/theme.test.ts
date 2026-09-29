import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isThemeShortcut } from '../src/lib/theme';
import { setSingleKeyShortcutsEnabled } from '../src/lib/shortcuts';

const bootstrap = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

function createThemePage({ stored = null, systemDark = false, blocked = false }: { stored?: string | null; systemDark?: boolean; blocked?: boolean } = {}) {
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const storage = new Map<string, string>(stored === null ? [] : [['ai-diff-theme', stored]]);
  const localStorage = {
    getItem: vi.fn((key: string) => { if (blocked) throw new Error('Storage blocked'); return storage.get(key) ?? null; }),
    setItem: vi.fn((key: string, value: string) => { if (blocked) throw new Error('Storage blocked'); storage.set(key, value); }),
  };
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const meta = { setAttribute: vi.fn() };
  let mediaListener: (() => void) | undefined;
  const media = { matches: systemDark, addEventListener: vi.fn((_type: string, listener: () => void) => { mediaListener = listener; }) };
  const window = {
    localStorage,
    matchMedia: vi.fn(() => media),
    addEventListener: vi.fn((name: string, listener: (event: Record<string, unknown>) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); }),
    dispatchEvent: vi.fn((event: Event | Record<string, unknown>) => { for (const listener of listeners.get(event.type as string) ?? []) listener(event as Record<string, unknown>); }),
  };
  runInNewContext(bootstrap, { window, document: { documentElement: root, querySelector: () => meta }, Event });
  return {
    root, meta, localStorage, window,
    setTheme: (theme: string) => window.dispatchEvent({ type: 'aidiff:set-theme', detail: theme }),
    setSystemDark: (matches: boolean) => { media.matches = matches; mediaListener?.(); },
    storageEvent: (key: string | null, newValue: string | null, storageArea: unknown = localStorage) => window.dispatchEvent({ type: 'storage', key, newValue, storageArea }),
  };
}

describe('early theme bootstrap', () => {
  it('uses the system theme immediately without persisting an implicit preference', () => {
    const page = createThemePage({ systemDark: true });
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.root.style).toEqual({ colorScheme: 'dark', backgroundColor: '#0a0a0a' });
    expect(page.meta.setAttribute).toHaveBeenLastCalledWith('content', '#0a0a0a');
    expect(page.localStorage.setItem).not.toHaveBeenCalled();
    page.setSystemDark(false);
    expect(page.root.dataset.theme).toBe('light');
    expect(page.meta.setAttribute).toHaveBeenLastCalledWith('content', '#fafafa');
  });

  it('honors an explicit stored choice until the user changes it', () => {
    const page = createThemePage({ stored: 'light', systemDark: true });
    expect(page.root.dataset.theme).toBe('light');
    page.setSystemDark(false);
    page.setSystemDark(true);
    expect(page.root.dataset.theme).toBe('light');
    page.setTheme('dark');
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.localStorage.setItem).toHaveBeenCalledExactlyOnceWith('ai-diff-theme', 'dark');
  });

  it('keeps system defaults and explicit in-tab choices working when storage is blocked', () => {
    const page = createThemePage({ blocked: true, systemDark: true });
    expect(page.root.dataset.theme).toBe('dark');
    page.setTheme('light');
    page.setSystemDark(false);
    page.setSystemDark(true);
    expect(page.root.dataset.theme).toBe('light');
  });

  it('syncs other tabs and resumes system-following after preference removal', () => {
    const page = createThemePage({ stored: 'light', systemDark: true });
    page.storageEvent('ai-diff-theme', 'dark');
    expect(page.root.dataset.theme).toBe('dark');
    page.storageEvent('ai-diff-theme', 'light');
    expect(page.root.dataset.theme).toBe('light');
    page.storageEvent('ai-diff-theme', null);
    expect(page.root.dataset.theme).toBe('dark');
    page.setSystemDark(false);
    expect(page.root.dataset.theme).toBe('light');
    expect(page.localStorage.setItem).not.toHaveBeenCalled();
  });

  it('ignores unrelated/session storage events and invalid requested values', () => {
    const page = createThemePage({ stored: 'dark', systemDark: false });
    page.storageEvent('unrelated', 'light');
    page.storageEvent('ai-diff-theme', 'light', {});
    page.setTheme('anything-else');
    expect(page.root.dataset.theme).toBe('dark');
    expect(page.localStorage.setItem).not.toHaveBeenCalled();
    page.storageEvent(null, null);
    expect(page.root.dataset.theme).toBe('light');
  });

  it('treats invalid saved preferences as system default', () => {
    const page = createThemePage({ stored: 'not-a-theme', systemDark: true });
    expect(page.root.dataset.theme).toBe('dark');
    page.setSystemDark(false);
    expect(page.root.dataset.theme).toBe('light');
  });
});

describe('theme keyboard shortcut', () => {
  afterEach(() => { vi.unstubAllGlobals(); setSingleKeyShortcutsEnabled(true); });

  function shortcutEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('Element', class {});
    return { key: 't', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: null, ...overrides } as KeyboardEvent;
  }

  it('accepts T and ignores browser shortcuts, held keys, and composition', () => {
    expect(isThemeShortcut(shortcutEvent())).toBe(true);
    expect(isThemeShortcut(shortcutEvent({ key: 'T' }))).toBe(true);
    for (const overrides of [{ key: 's' }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      expect(isThemeShortcut(shortcutEvent(overrides))).toBe(false);
    }
  });

  it('does not act while a dialog is open', () => {
    const event = shortcutEvent();
    vi.stubGlobal('document', { querySelector: () => ({ open: true }) });
    expect(isThemeShortcut(event)).toBe(false);
  });

  it('respects the single-key shortcut switch and resumes when re-enabled', () => {
    const event = shortcutEvent();
    setSingleKeyShortcutsEnabled(false);
    expect(isThemeShortcut(event)).toBe(false);
    setSingleKeyShortcutsEnabled(true);
    expect(isThemeShortcut(event)).toBe(true);
  });

  it('does not act in a text input, editor, or select-like control', () => {
    const event = shortcutEvent();
    class EditingElement {
      closest = vi.fn(() => this);
    }
    vi.stubGlobal('Element', EditingElement);
    const target = new EditingElement();
    expect(isThemeShortcut({ ...event, target } as unknown as KeyboardEvent)).toBe(false);
    expect(target.closest).toHaveBeenCalledWith('input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"]');
  });
});
