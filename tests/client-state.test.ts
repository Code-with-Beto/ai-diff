import { describe, expect, it } from 'vitest';
import { callbackMessage, comparisonDateAllowed, createOperationScope, isAuthenticationError, normalizeRepositoryUrl } from '../src/lib/client-state';

describe('frontend request lifecycle', () => {
  it('rejects late results after a newer discovery request replaces the old one', () => {
    const scope = createOperationScope();
    const old = scope.start('discovery');
    const current = scope.start('discovery');
    expect(old.signal.aborted).toBe(true);
    expect(old.isActive()).toBe(false);
    old.finish();
    expect(current.isActive()).toBe(true);
  });
  it('lets cancellation finalize partial coverage but invalidates all writes after logout or unmount', () => {
    const scope = createOperationScope();
    const scan = scope.start('scan');
    scope.cancel('scan');
    expect(scan.isCurrent()).toBe(true);
    expect(scan.isActive()).toBe(false);
    const add = scope.start('add');
    scope.invalidateAll();
    expect(scan.isCurrent()).toBe(false);
    expect(add.isActive()).toBe(false);
    expect(add.signal.aborted).toBe(true);
  });
  it('does not invalidate independent requests and never lets an old completion remove a new task', () => {
    const scope = createOperationScope();
    const discovery = scope.start('discovery');
    const add = scope.start('add');
    discovery.finish();
    expect(add.isActive()).toBe(true);
    expect(discovery.isActive()).toBe(false);
  });
});

describe('frontend boundary handling', () => {
  it('recognizes exact backend authentication codes without treating permission errors as expired sign-in', () => {
    expect(isAuthenticationError({ code: 'authentication_required' })).toBe(true);
    expect(isAuthenticationError({ code: 'session_expired' })).toBe(true);
    expect(isAuthenticationError({ code: 'repository_unavailable' })).toBe(false);
    expect(isAuthenticationError(new Error('token failed'))).toBe(false);
  });
  it('limits custom dates to the current report snapshot and checks real calendar dates', () => {
    expect(comparisonDateAllowed('2026-09-29', '2026-09-29')).toBe(true);
    expect(comparisonDateAllowed('2026-09-30', '2026-09-29')).toBe(false);
    expect(comparisonDateAllowed('2025-02-30', '2026-09-29')).toBe(false);
    expect(comparisonDateAllowed('', '2026-09-29')).toBe(false);
    expect(comparisonDateAllowed('1969-12-31', '2026-09-29')).toBe(false);
  });
  it('normalizes the advertised GitHub URL shortcut without changing other hosts or schemes', () => {
    expect(normalizeRepositoryUrl(' github.com/owner/repo ')).toBe('https://github.com/owner/repo');
    expect(normalizeRepositoryUrl('http://github.com/owner/repo')).toBe('http://github.com/owner/repo');
    expect(normalizeRepositoryUrl('evil.test/repo')).toBe('evil.test/repo');
  });
  it('maps callbacks to fixed safe messages without echoing arbitrary URL input', () => {
    expect(callbackMessage('?auth=expired')).toContain('expired');
    expect(callbackMessage('?auth=installation_failed')).toContain('Private repository setup');
    expect(callbackMessage('?auth=%3Cscript%3E')).toBe('');
    expect(callbackMessage('?auth=__proto__')).toBe('');
    expect(callbackMessage('?auth=constructor')).toBe('');
    expect(callbackMessage('?private=connected')).toBe('');
  });
});
