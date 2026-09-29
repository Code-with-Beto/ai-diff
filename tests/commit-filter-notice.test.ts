import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, CommitFilterSummary, CommitRecord, RepositoryProgress } from '../shared/types';
import { CommitFilterNotice } from '../src/components/CommitFilter';
import { analyzeCommits } from '../src/lib/analysis';
import { createShareResult, decodeShare, encodeShare } from '../src/lib/share';

const repositories: RepositoryProgress[] = [{
  repository: { id: 'repo', nameWithOwner: 'dev/example', isPrivate: false, isFork: false, isArchived: false, description: null },
  status: 'complete', commits: 2,
}];

function sharedResult(scope: CommitFilterSummary['scope'], enabled = true, excludeBefore = false): AnalysisResult {
  const commits: CommitRecord[] = [
    { oid: 'before', authorId: 'dev', parentCount: 1, committedDate: '2025-11-23T12:00:00Z', additions: excludeBefore ? 200_000 : 20, deletions: 0 },
    { oid: 'after', authorId: 'dev', parentCount: 1, committedDate: '2025-11-25T12:00:00Z', additions: scope === 'before' ? 200_000 : 40, deletions: 0 },
  ];
  const result = analyzeCommits(commits, 'dev', '2025-11-24', '2026-01-01T00:00:00Z', repositories, { enabled, scope });
  const snapshot = decodeShare(encodeShare(createShareResult('dev', result)))!;
  expect(snapshot).not.toHaveProperty('oversizedCommits');
  return { ...snapshot, months: [], ratio: null };
}

function collapsedSummary(result: AnalysisResult) {
  const markup = renderToStaticMarkup(createElement(CommitFilterNotice, { result }));
  expect(markup).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
  return markup.match(/<summary>(.*?)<\/summary>/)?.[1] ?? '';
}

describe('shared result commit-filter notice', () => {
  it('discloses before-only filtering in the collapsed summary even with zero exclusions and no raw commits', () => {
    const result = sharedResult('before');
    expect(result.commitFilter?.excludedBefore.commits).toBe(0);
    expect(result.commitFilter?.excludedAfter.commits).toBe(0);
    const summary = collapsedSummary(result);
    expect(summary).toContain('No large commits excluded');
    expect(summary).toContain('before-only (unequal filter)');
  });

  it('keeps the unequal qualifier visible alongside nonzero shared exclusions', () => {
    const summary = collapsedSummary(sharedResult('before', true, true));
    expect(summary).toContain('1 large commit excluded');
    expect(summary).toContain('before-only (unequal filter)');
  });

  it('omits an empty notice for equal-period or disabled filters', () => {
    for (const result of [sharedResult('both'), sharedResult('before', false)]) {
      expect(renderToStaticMarkup(createElement(CommitFilterNotice, { result }))).toBe('');
    }
  });
});
