const keyFor = (accountId: string) => `ai-diff:private-repositories:${accountId}`;

/** Only a per-account inclusion preference is stored, never repository data. */
export function readPrivateRepositoryPreference(accountId: string): boolean {
  try { return localStorage.getItem(keyFor(accountId)) !== 'off'; }
  catch { return true; }
}

export function savePrivateRepositoryPreference(accountId: string, enabled: boolean): void {
  try { localStorage.setItem(keyFor(accountId), enabled ? 'on' : 'off'); }
  catch { /* Browsers can disable storage; the current page still works. */ }
}
