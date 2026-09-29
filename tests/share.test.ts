import { describe, expect, it } from 'vitest';
import { createShareResult, createShareText, createShareUrl, decodeShare, encodeShare, MAX_SHARE_PAYLOAD_LENGTH } from '../src/lib/share.ts';
import { analyzeCommits } from '../src/lib/analysis.ts';
import type { ShareResult } from '../shared/types.ts';

const fixture: ShareResult = {
  version: 1, login: 'octo-dev', cutoff: '2025-09-29', asOf: '2026-09-29T12:00:00.000Z',
  firstCommitAt: '2019-01-01T00:00:00.000Z', before: { additions: 20000, deletions: 2000, commits: 100 },
  after: { additions: 60000, deletions: 15000, commits: 200 },
  coverage: { completed: 3, unavailable: 1, incomplete: 2, total: 6 }, includesPrivate: true, sample: false,
};
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('aggregate sharing', () => {
  it('round-trips bounded aggregates and accepts the browser hash without leaking query values', () => {
    expect(decodeShare(encodeShare(fixture))).toEqual(fixture);
    const url = new URL(createShareUrl(fixture, 'https://example.test/path?unrelated=1'));
    expect(url.pathname).toBe('/share');
    expect(url.search).toBe('');
    expect(decodeShare(url.hash)).toEqual(fixture);
  });

  it('includes only aggregate fields in the snapshot', () => {
    const result = analyzeCommits([], 'dev', '2025-09-29', fixture.asOf, []);
    const snapshot = createShareResult('octo-dev', result, true);
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(fixture).sort());
    expect(snapshot.sample).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('months');
    expect(decodeShare(encodeShare(snapshot))).toEqual(snapshot);
  });

  it.each(['', '#', 'not valid!', '%%%%', 'a', '#eyJ9', 'A'.repeat(MAX_SHARE_PAYLOAD_LENGTH + 1), raw('hello'), raw(null), raw([])])('rejects malformed or oversized payload %s', payload => {
    expect(decodeShare(payload)).toBeNull();
  });

  it('rejects noncanonical base64, malformed UTF-8 and JSON padding attacks', () => {
    expect(decodeShare(encodeShare(fixture) + '=')).toBeNull();
    expect(decodeShare('_w')).toBeNull();
    expect(decodeShare(Buffer.from(' '.repeat(4200) + JSON.stringify(fixture)).toString('base64url'))).toBeNull();
  });

  it.each([
    { ...fixture, version: 2 },
    { ...fixture, login: '<script>alert(1)</script>' },
    { ...fixture, login: 'a'.repeat(40) },
    { ...fixture, login: 'two--hyphens' },
    { ...fixture, cutoff: '2025-02-30' },
    { ...fixture, asOf: 'yesterday' },
    { ...fixture, asOf: '2026-02-30T12:00:00.000Z' },
    { ...fixture, firstCommitAt: '2027-01-01T00:00:00.000Z' },
    { ...fixture, firstCommitAt: null },
    { ...fixture, firstCommitAt: '2025-10-01T00:00:00.000Z' },
    { ...fixture, cutoff: '2027-01-01' },
    { ...fixture, sample: 'false' },
    { ...fixture, includesPrivate: null },
    { ...fixture, token: 'secret' },
    { ...fixture, before: { ...fixture.before, additions: -1 } },
    { ...fixture, before: { ...fixture.before, additions: 0.5 } },
    { ...fixture, before: { ...fixture.before, additions: Number.MAX_SAFE_INTEGER + 1 } },
    { ...fixture, before: { ...fixture.before, additions: Number.MAX_SAFE_INTEGER } },
    { ...fixture, before: { ...fixture.before, commits: 0 } },
    { ...fixture, before: { ...fixture.before, repository: 'private/name' } },
    { ...fixture, coverage: { ...fixture.coverage, total: 8 } },
    { ...fixture, coverage: { completed: 0, unavailable: 0, incomplete: 0, total: 0 } },
    { ...fixture, coverage: { completed: 100001, unavailable: 0, incomplete: 0, total: 100001 } },
  ])('rejects tampered or inconsistent field structures %#', candidate => {
    expect(decodeShare(raw(candidate))).toBeNull();
    expect(() => encodeShare(candidate as ShareResult)).toThrow();
  });

  it('rejects non-finite values at encoding even though JSON would replace them with null', () => {
    expect(() => encodeShare({ ...fixture, after: { ...fixture.after, additions: Infinity } })).toThrow();
    expect(() => encodeShare({ ...fixture, after: { ...fixture.after, additions: NaN } })).toThrow();
  });

  it('preserves valid partial coverage and zero-addition commits', () => {
    const value = { ...fixture, after: { additions: 0, deletions: 400, commits: 3 } };
    expect(decodeShare(encodeShare(value))).toEqual(value);
  });

  it('does not imply cryptographic verification: structurally valid edits remain self-reported', () => {
    const edited = { ...fixture, after: { ...fixture.after, additions: 999999 } };
    expect(decodeShare(raw(edited))).toEqual(edited);
  });

  it('shares truthful partial sample/private text with real ranges and a canonical tool link', () => {
    const text = createShareText({ ...fixture, sample: true });
    expect(text).toContain('Sample GitHub history for @octo-dev (fictional demo).');
    expect(text).toContain('Before (Jan 1, 2019 – Sep 28, 2025): 20,000 lines added.');
    expect(text).toContain('After (Sep 29, 2025 – Sep 29, 2026): 60,000 lines added.');
    expect(text).toContain('Cutoff: Sep 29, 2025, 00:00 UTC.');
    expect(text).toContain('3/6 repositories complete; partial results (2 incomplete, 1 unavailable)');
    expect(text).toContain('Includes fictional private repository totals.');
    expect(text).toContain('Different time spans. Self-reported Git activity, not a productivity measure or proof of AI use.');
    expect(text).toContain('https://aidiff.cwb.sh');
    expect(text).not.toContain('/share#');
    expect(text).not.toContain(encodeShare(fixture));
    expect(createShareText(fixture)).toContain('Includes private repository totals.');
  });
});
