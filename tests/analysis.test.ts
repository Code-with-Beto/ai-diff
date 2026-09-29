import { describe, expect, it } from 'vitest';
import { analyzeCommits } from '../src/lib/analysis.ts';
import { SAMPLE_AS_OF, SAMPLE_COMMITS, SAMPLE_REPOSITORIES, SAMPLE_USER } from '../src/lib/sample.ts';
import type { CommitRecord, RepositoryProgress } from '../shared/types.ts';

const repository = { id: 'repo-1', nameWithOwner: 'dev/project', isPrivate: false, isFork: false, isArchived: false, description: null };
const progress: RepositoryProgress[] = [{ repository, status: 'complete', commits: 0 }];
const commit = (oid: string, committedDate: string, additions = 5, rest: Partial<CommitRecord> = {}): CommitRecord => ({ oid, committedDate, additions, deletions: 2, authorId: 'dev', parentCount: 1, ...rest });
const analyze = (commits: CommitRecord[], selected = progress) => analyzeCommits(commits, 'dev', '2025-09-29', '2025-12-01T00:00:00.000Z', selected);

describe('commit analysis', () => {
  it('deduplicates SHAs across pages and repositories and strictly matches the primary author', () => {
    const own = commit('same', '2025-09-01T00:00:00.000Z');
    const result = analyze([own, own, { ...own }, commit('other', own.committedDate, 999, { authorId: 'other' }), commit('missing', own.committedDate, 999, { authorId: null })]);
    expect(result.before).toEqual({ additions: 5, deletions: 2, commits: 1 });
  });

  it('uses the UTC midnight boundary with before exclusive and after inclusive', () => {
    const result = analyze([
      commit('before', '2025-09-28T23:59:59.999Z', 10),
      commit('boundary', '2025-09-29T00:00:00.000Z', 20),
      commit('offset', '2025-09-28T20:00:00-04:00', 30),
    ]);
    expect(result.before.additions).toBe(10);
    expect(result.after.additions).toBe(50);
    expect(result.months[0]).toEqual({ month: '2025-09', before: 10, after: 50 });
  });

  it('includes root commits, excludes merge commits and freezes the snapshot at asOf', () => {
    const result = analyze([
      commit('root', '2025-01-01T00:00:00.000Z', 7, { parentCount: 0 }),
      commit('merge', '2025-10-01T00:00:00.000Z', 500, { parentCount: 2 }),
      commit('at-end', '2025-12-01T00:00:00.000Z', 11),
      commit('future', '2025-12-01T00:00:00.001Z', 500),
    ]);
    expect(result.before.additions).toBe(7);
    expect(result.after.additions).toBe(11);
    expect(result.firstCommitAt).toBe('2025-01-01T00:00:00.000Z');
    expect(result.months).toHaveLength(12);
    expect(result.months[1]).toEqual({ month: '2025-02', before: 0, after: 0 });
    expect(result.ratio).toBe(11 / 7);
  });

  it('does not invent a multiplier or a history start when there is no baseline', () => {
    const empty = analyze([]);
    expect(empty.ratio).toBeNull();
    expect(empty.firstCommitAt).toBeNull();
    expect(empty.months).toEqual([]);
    expect(analyze([commit('after', '2025-10-01T00:00:00.000Z')]).ratio).toBeNull();
  });

  it('counts selected repository coverage without treating partial or unavailable scans as complete', () => {
    const selected: RepositoryProgress[] = ['pending', 'scanning', 'incomplete', 'unavailable', 'complete'].map((status, index) => ({
      repository: { ...repository, id: `${index}`, isPrivate: index === 1 }, status: status as RepositoryProgress['status'], commits: 0,
    }));
    const result = analyze([], selected);
    expect(result.coverage).toEqual({ total: 5, completed: 1, incomplete: 3, unavailable: 1 });
    expect(result.includesPrivate).toBe(true);
    expect(analyze([], [{ repository: { ...repository, isPrivate: true }, status: 'pending', commits: 0 }]).includesPrivate).toBe(false);
  });

  it('ignores invalid commit statistics and invalid dates instead of contaminating totals', () => {
    expect(analyze([
      commit('bad-add', '2025-01-01T00:00:00.000Z', NaN),
      commit('negative', '2025-01-01T00:00:00.000Z', -1),
      commit('bad-date', 'not-a-date'),
      commit('infinity', '2025-01-01T00:00:00.000Z', Infinity),
    ]).before.commits).toBe(0);
    expect(() => analyzeCommits([], 'dev', '2025-02-30', '2025-12-01T00:00:00.000Z', [])).toThrow();
  });

  it('keeps the deterministic illustrative sample separate from actual user history', () => {
    const result = analyzeCommits(SAMPLE_COMMITS, SAMPLE_USER.id, '2025-09-29', SAMPLE_AS_OF, SAMPLE_REPOSITORIES.map(repository => ({ repository, status: 'complete', commits: 0 })));
    expect(result.firstCommitAt?.slice(0, 4)).toBe('2019');
    expect(result.months.at(-1)?.month).toBe('2026-09');
    expect(result.after.additions).toBeGreaterThan(result.before.additions);
    expect(result.coverage.completed).toBe(4);
    expect(result.includesPrivate).toBe(true);
  });
});
