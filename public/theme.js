// This parser-blocking, same-origin script applies the theme before first paint.
// Keep these two background colors aligned with the global theme tokens.
(function () {
  'use strict';

  var storageKey = 'ai-diff-theme';
  var colors = { light: '#fafafa', dark: '#0a0a0a' };
  var media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var preference = null;

  function validTheme(value) {
    return value === 'light' || value === 'dark';
  }

  try {
    var stored = window.localStorage.getItem(storageKey);
    preference = validTheme(stored) ? stored : null;
  } catch (_) {
    // Storage can be blocked. System defaults and in-tab changes still work.
  }

  function applyTheme() {
    var theme = preference || (media && media.matches ? 'dark' : 'light');
    var root = document.documentElement;
    var changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.style.backgroundColor = colors[theme];
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors[theme]);
    if (changed) window.dispatchEvent(new Event('aidiff:theme-change'));
  }

  window.addEventListener('aidiff:set-theme', function (event) {
    if (!validTheme(event.detail)) return;
    preference = event.detail;
    try {
      window.localStorage.setItem(storageKey, preference);
    } catch (_) {
      // Preserve the explicit choice in memory if persistence is unavailable.
    }
    applyTheme();
  });

  window.addEventListener('storage', function (event) {
    if (event.key !== storageKey && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch (_) {
      return;
    }
    preference = validTheme(event.newValue) ? event.newValue : null;
    applyTheme();
  });

  function systemChanged() {
    if (!preference) applyTheme();
  }
  if (media) {
    if (typeof media.addEventListener === 'function') media.addEventListener('change', systemChanged);
    else if (typeof media.addListener === 'function') media.addListener(systemChanged);
  }

  applyTheme();
}());
