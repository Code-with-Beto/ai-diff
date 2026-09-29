import type { AnalysisResult, AnalyzedCommit, CommitFilterSummary, CommitRecord, FileFilterSummary, MonthTotal, RepositoryProgress, Totals } from '../../shared/types.ts';

const emptyTotals = (): Totals => ({ additions: 0, deletions: 0, commits: 0 });
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
import { excludedFileLines, hasCompleteFiles } from '../../shared/file-policy.ts';
import { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from '../../shared/analysis-rules.ts';
export { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from '../../shared/analysis-rules.ts';
export interface CommitFilterOptions { enabled?: boolean; scope?: 'both' | 'before'; excludeLockfiles?: boolean }

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
  const fileFilter: FileFilterSummary | undefined = filter.excludeLockfiles === undefined ? undefined : {
    enabled: filter.excludeLockfiles, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 },
    inspectedCommits: 0, uninspectedBefore: emptyTotals(), uninspectedAfter: emptyTotals(),
  };
  const details: AnalyzedCommit[] = [];
  let first = Infinity, firstObserved = Infinity;

  // A failed copy of a SHA must not hide a later successful read of the same commit.
  const completeCopies = new Map<string, CommitRecord>();
  for (const candidate of commits) {
    if (candidate.authorId === userId && candidate.parentCount <= 1 && hasCompleteFiles(candidate)) completeCopies.set(candidate.oid, candidate);
  }
  for (const original of commits) {
    const copy = completeCopies.get(original.oid);
    const commit = copy && copy.additions === original.additions && copy.deletions === original.deletions && copy.committedDate === original.committedDate
      ? { ...original, files: copy.files, filesComplete: true, changedFiles: copy.changedFiles, filesError: undefined } : original;
    const date = Date.parse(commit.committedDate);
    if (
      !userId || !commit.oid || seen.has(commit.oid) || commit.authorId !== userId ||
      !Number.isInteger(commit.parentCount) || commit.parentCount < 0 || commit.parentCount > 1 ||
      !integer(commit.additions) || !integer(commit.deletions) || !Number.isFinite(date) || date > end
    ) continue;
    seen.add(commit.oid);
    const period = date < boundary ? 'before' : 'after';
    firstObserved = Math.min(firstObserved, date);
    const complete = hasCompleteFiles(commit);
    const locks = complete ? commit.files!.reduce((sum, file) => {
      const excluded = excludedFileLines(file);
      return { additions: sum.additions + excluded.additions, deletions: sum.deletions + excluded.deletions };
    }, { additions: 0, deletions: 0 }) : { additions: 0, deletions: 0 };
    const detail: AnalyzedCommit = { ...commit, filesComplete: complete, countedAdditions: 0, countedDeletions: 0,
      lockfileAdditions: locks.additions, lockfileDeletions: locks.deletions, exclusion: null };
    details.push(detail);
    if (fileFilter) {
      if (complete) fileFilter.inspectedCommits += 1;
      else addCommit(period === 'before' ? fileFilter.uninspectedBefore : fileFilter.uninspectedAfter, commit);
      if (fileFilter.enabled) {
        if (!complete) { detail.exclusion = 'files_unavailable'; continue; }
        const excluded = period === 'before' ? fileFilter.excludedBefore : fileFilter.excludedAfter;
        excluded.additions += locks.additions; excluded.deletions += locks.deletions;
        if (!Number.isSafeInteger(excluded.additions) || !Number.isSafeInteger(excluded.deletions)) throw new Error('This history is too large to total safely.');
      }
    }
    const counted = { ...commit,
      additions: commit.additions - (fileFilter?.enabled ? locks.additions : 0),
      deletions: commit.deletions - (fileFilter?.enabled ? locks.deletions : 0),
    };
    // Apply the size heuristic to the same remaining file counts in both periods.
    if (counted.additions > OVERSIZED_COMMIT_THRESHOLD - counted.deletions) {
      oversizedCommits.push(counted);
      if (commitFilter.enabled && (commitFilter.scope === 'both' || period === 'before')) {
        addCommit(period === 'before' ? commitFilter.excludedBefore : commitFilter.excludedAfter, counted);
        detail.exclusion = 'oversized';
        continue;
      }
    }
    first = Math.min(first, date);
    detail.countedAdditions = counted.additions; detail.countedDeletions = counted.deletions;
    const totals = period === 'before' ? before : after;
    addCommit(totals, counted);
    const month = new Date(date).toISOString().slice(0, 7);
    const bin = monthly.get(month) ?? { month, before: 0, after: 0 };
    bin[period] += counted.additions;
    monthly.set(month, bin);
  }

  const months: MonthTotal[] = [];
  const chartStart = fileFilter ? firstObserved : first;
  if (Number.isFinite(chartStart)) {
    const current = new Date(chartStart);
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
    before, after, months, cutoff, asOf: new Date(end).toISOString(), coverage, commitFilter, oversizedCommits, details, ...(fileFilter ? { fileFilter } : {}),
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
