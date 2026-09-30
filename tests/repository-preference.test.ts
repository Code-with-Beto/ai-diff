import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPrivateRepositoryPreference, savePrivateRepositoryPreference } from '../src/lib/repository-preference';

afterEach(() => vi.unstubAllGlobals());

describe('private repository inclusion preference', () => {
  it('includes already-authorized repositories by default and remembers an explicit opt-out per account', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(readPrivateRepositoryPreference('account-a')).toBe(true);
    savePrivateRepositoryPreference('account-a', false);
    expect(readPrivateRepositoryPreference('account-a')).toBe(false);
    expect(readPrivateRepositoryPreference('account-b')).toBe(true);
    expect([...values.values()]).toEqual(['off']);
    savePrivateRepositoryPreference('account-a', true);
    expect(readPrivateRepositoryPreference('account-a')).toBe(true);
  });

  it('works when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage blocked'); }, setItem: () => { throw new Error('Storage blocked'); } });
    expect(readPrivateRepositoryPreference('account-a')).toBe(true);
    expect(() => savePrivateRepositoryPreference('account-a', false)).not.toThrow();
  });
});
