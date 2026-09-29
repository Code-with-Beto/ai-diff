import type { AnalysisResult, CommitFilterSummary, CommitRecord, MonthTotal, RepositoryProgress, Totals } from '../../shared/types.ts';

const emptyTotals = (): Totals => ({ additions: 0, deletions: 0, commits: 0 });
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
import { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from '../../shared/analysis-rules.ts';
export { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from '../../shared/analysis-rules.ts';
export interface CommitFilterOptions { enabled?: boolean; scope?: 'both' | 'before' }

function addCommit(totals: Totals, commit: CommitRecord): void {
  totals.additions += commit.additions;
  totals.deletions += commit.deletions;
  totals.commits += 1;
  if (!Number.isSafeInteger(totals.additions) || !Number.isSafeInteger(totals.deletions)) {
    throw new Error('This history is too large to total safely.');
  }
}


export function analyzeCommits(
  commits: CommitRecord[],
  userId: string,
  cutoff: string,
  asOf: string,
  progress: RepositoryProgress[],
  filter: CommitFilterOptions = {},
): AnalysisResult {
  const end = Date.parse(asOf);
  if (!isDateOnly(cutoff) || !Number.isFinite(end)) throw new Error('Choose a valid comparison date.');
  const boundary = Date.parse(`${cutoff}T00:00:00.000Z`);
  const before = emptyTotals();
  const after = emptyTotals();
  const seen = new Set<string>();
  const monthly = new Map<string, MonthTotal>();
  const oversizedCommits: CommitRecord[] = [];
  const commitFilter: CommitFilterSummary = {
    enabled: filter.enabled ?? true, scope: filter.scope ?? 'both', threshold: OVERSIZED_COMMIT_THRESHOLD,
    excludedBefore: emptyTotals(), excludedAfter: emptyTotals(),
  };
  let first = Infinity;

  for (const commit of commits) {
    const date = Date.parse(commit.committedDate);
    if (
      !userId || !commit.oid || seen.has(commit.oid) || commit.authorId !== userId ||
      !Number.isInteger(commit.parentCount) || commit.parentCount < 0 || commit.parentCount > 1 ||
      !integer(commit.additions) || !integer(commit.deletions) || !Number.isFinite(date) || date > end
    ) continue;
    seen.add(commit.oid);
    const period = date < boundary ? 'before' : 'after';
    // A size heuristic, not proof of dependencies, generated files, or authorship.
    // Check after author/merge validation and SHA deduplication, before any totals.
    if (commit.additions > OVERSIZED_COMMIT_THRESHOLD - commit.deletions) {
      oversizedCommits.push(commit);
      if (commitFilter.enabled && (commitFilter.scope === 'both' || period === 'before')) {
        addCommit(period === 'before' ? commitFilter.excludedBefore : commitFilter.excludedAfter, commit);
        continue;
      }
    }
    first = Math.min(first, date);
    const totals = period === 'before' ? before : after;
    addCommit(totals, commit);
    const month = new Date(date).toISOString().slice(0, 7);
    const bin = monthly.get(month) ?? { month, before: 0, after: 0 };
    bin[period] += commit.additions;
    monthly.set(month, bin);
  }

  const months: MonthTotal[] = [];
  if (Number.isFinite(first)) {
    const current = new Date(first);
    current.setUTCDate(1);
    current.setUTCHours(0, 0, 0, 0);
    const lastMonth = new Date(end).toISOString().slice(0, 7);
    // Git timestamps can be malformed; avoid unbounded chart allocation.
    if ((new Date(end).getUTCFullYear() - current.getUTCFullYear()) > 200) {
      throw new Error('This history spans an unsupported date range.');
    }
    while (current.toISOString().slice(0, 7) <= lastMonth) {
      const month = current.toISOString().slice(0, 7);
      months.push(monthly.get(month) ?? { month, before: 0, after: 0 });
      current.setUTCMonth(current.getUTCMonth() + 1);
    }
  }

  const repositories = [...new Map(progress.map(item => [item.repository.id, item])).values()];
  const coverage = { completed: 0, unavailable: 0, incomplete: 0, total: repositories.length };
  for (const item of repositories) {
    if (item.status === 'complete') coverage.completed += 1;
    else if (item.status === 'unavailable') coverage.unavailable += 1;
    else coverage.incomplete += 1;
  }

  return {
    before, after, months, cutoff, asOf: new Date(end).toISOString(), coverage, commitFilter, oversizedCommits,
    firstCommitAt: Number.isFinite(first) ? new Date(first).toISOString() : null,
    includesPrivate: repositories.some(item => item.repository.isPrivate && item.status !== 'pending'),
    ratio: before.additions === 0 ? null : after.additions / before.additions,
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

export function formatDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)
    : 'Unknown date';
}
