import { describe, expect, it, vi } from 'vitest';
import { analyzeCommits, OVERSIZED_COMMIT_THRESHOLD } from '../src/lib/analysis';
import { createShareResult, createShareText, decodeShare, encodeShare, renderShareImage } from '../src/lib/share';
import type { CommitRecord, RepositoryProgress } from '../shared/types';

const before = '2025-11-23T23:59:59.999Z';
const boundary = '2025-11-24T00:00:00.000Z';
const asOf = '2026-01-01T00:00:00.000Z';
const progress: RepositoryProgress[] = [{ repository: { id: 'repo', nameWithOwner: 'dev/private-repo', isPrivate: true, isFork: false, isArchived: false, description: null }, status: 'complete', commits: 0 }];
const commit = (oid: string, additions: number, deletions = 0, committedDate = before, rest: Partial<CommitRecord> = {}): CommitRecord => ({ oid, additions, deletions, committedDate, authorId: 'dev', parentCount: 1, ...rest });
const analyze = (commits: CommitRecord[], filter = {}, cutoff = '2025-11-24') => analyzeCommits(commits, 'dev', cutoff, asOf, progress, filter);

describe('oversized commit filtering', () => {
  it('skips only commits strictly above the combined added/deleted threshold', () => {
    const result = analyze([commit('at-limit', 60_000, 40_000), commit('above', 60_001, 40_000), commit('deletion', 0, 100_001)]);
    expect(result.before).toEqual({ additions: 60_000, deletions: 40_000, commits: 1 });
    expect(result.commitFilter?.excludedBefore).toEqual({ additions: 60_001, deletions: 140_001, commits: 2 });
    expect(result.commitFilter?.threshold).toBe(OVERSIZED_COMMIT_THRESHOLD);
  });

  it('filters both periods by default, including root imports, after deduplication and author checks', () => {
    const big = commit('import', 7_000_000, 0, before, { parentCount: 0 });
    const result = analyze([big, big, commit('new-import', 200_000, 5, boundary), commit('normal', 10), commit('other', 300_000, 0, before, { authorId: 'other' }), commit('merge', 300_000, 0, before, { parentCount: 2 }), commit('future', 300_000, 0, '2026-01-02T00:00:00Z')]);
    expect(result.before.additions).toBe(10);
    expect(result.after.additions).toBe(0);
    expect(result.oversizedCommits?.map(item => item.oid)).toEqual(['import', 'new-import']);
    expect(result.commitFilter?.excludedBefore.commits).toBe(1);
    expect(result.commitFilter?.excludedAfter.commits).toBe(1);
    expect(result.months.reduce((total, month) => total + month.before + month.after, 0)).toBe(10);
    expect(result.coverage).toEqual({ completed: 1, unavailable: 0, incomplete: 0, total: 1 });
  });

  it('restores raw additions, deletions, dates and ratios without changing input history', () => {
    const commits = [commit('old-import', 1_000_000, 20, '2020-01-01T00:00:00Z'), commit('normal', 25), commit('after', 50, 10, boundary)];
    const filtered = analyze(commits);
    const raw = analyze(commits, { enabled: false });
    expect(filtered.ratio).toBe(2);
    expect(filtered.firstCommitAt).toBe(before);
    expect(raw.before).toEqual({ additions: 1_000_025, deletions: 20, commits: 2 });
    expect(raw.firstCommitAt).toBe('2020-01-01T00:00:00.000Z');
    expect(raw.ratio).toBe(50 / 1_000_025);
    expect(raw.commitFilter?.excludedBefore.commits).toBe(0);
    expect(raw.oversizedCommits).toHaveLength(1);
    expect(analyze(commits)).toEqual(filtered);
  });

  it('supports an explicit before-only scope and recalculates exclusions when cutoff changes', () => {
    const commits = [commit('large', 100_001, 0, boundary)];
    const result = analyze(commits, { scope: 'before' });
    expect(result.after.additions).toBe(100_001);
    expect(result.commitFilter?.excludedAfter.commits).toBe(0);
    const changed = analyze(commits, { scope: 'before' }, '2025-11-25');
    expect(changed.before.additions).toBe(0);
    expect(changed.commitFilter?.excludedBefore.commits).toBe(1);
  });

  it('keeps an entirely filtered history shareable with zero totals and completed coverage', () => {
    const result = analyze([commit('only', 2_000_000)]);
    expect(result.firstCommitAt).toBeNull();
    expect(result.months).toEqual([]);
    expect(result.ratio).toBeNull();
    const snapshot = createShareResult('dev', result);
    expect(decodeShare(encodeShare(snapshot))).toEqual(snapshot);
    expect(snapshot.commitFilter?.excludedBefore.additions).toBe(2_000_000);
  });

  it('preserves aggregate filter disclosure in links and text without raw commits or private names', () => {
    const snapshot = createShareResult('dev', analyze([commit('private-secret-sha', 2_000_000), commit('normal', 10)]));
    expect(decodeShare(encodeShare(snapshot))?.commitFilter).toEqual(snapshot.commitFilter);
    expect(createShareText(snapshot)).toContain('100,000 changed lines · 1 commit excluded · both periods');
    expect(JSON.stringify(snapshot)).not.toMatch(/private-secret-sha|private-repo|authorId|oversizedCommits/);
    const unequal = createShareResult('dev', analyze([commit('huge', 2_000_000)], { scope: 'before' }));
    expect(createShareText(unequal)).toContain('before only (unequal filter)');
  });

  it('rejects invalid or privacy-expanding filter payloads', () => {
    const snapshot = createShareResult('dev', analyze([commit('huge', 2_000_000)]));
    for (const changes of [
      { threshold: 0 }, { threshold: 50_000 }, { enabled: false }, { scope: 'other' }, { token: 'nope' },
      { excludedBefore: { additions: 1, deletions: 0, commits: 1 } },
      { excludedBefore: { additions: 2_000_000, deletions: 0, commits: 1, repository: 'private/name' } },
      { excludedBefore: { additions: Number.MAX_SAFE_INTEGER, deletions: 0, commits: 1 }, excludedAfter: { additions: 2_000_000, deletions: 0, commits: 1 } },
    ]) {
      const candidate = { ...snapshot, commitFilter: { ...snapshot.commitFilter, ...changes } };
      expect(decodeShare(Buffer.from(JSON.stringify(candidate)).toString('base64url'))).toBeNull();
    }
  });

  it('exports counted totals without filter labels while preserving the text summary', async () => {
    const labels: string[] = [];
    const context = { fillStyle: '', font: '', fillRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(), measureText: (value: string) => ({ width: value.length * 8 }), fillText: (value: string) => labels.push(value) };
    vi.stubGlobal('document', { fonts: { ready: Promise.resolve() }, createElement: () => ({ getContext: () => context, toBlob: (callback: (value: Blob) => void) => callback(new Blob(['image'], { type: 'image/png' })) }) });
    try {
      const snapshot = createShareResult('dev', analyze([commit('big', 7_000_000), commit('normal', 25)]));
      await renderShareImage(snapshot);
      expect(labels).toContain('25');
      expect(labels).not.toContain('7,000,025');
      expect(labels.some(label => /excluded|private|complete|partial/i.test(label))).toBe(false);
      expect(createShareText(snapshot)).toContain('1 commit excluded');
    } finally { vi.unstubAllGlobals(); }
  });
});
