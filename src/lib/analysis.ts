import type { AnalysisResult, CommitRecord, MonthTotal, RepositoryProgress, Totals } from '../../shared/types.ts';

const emptyTotals = (): Totals => ({ additions: 0, deletions: 0, commits: 0 });
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function analyzeCommits(
  commits: CommitRecord[],
  userId: string,
  cutoff: string,
  asOf: string,
  progress: RepositoryProgress[],
): AnalysisResult {
  const end = Date.parse(asOf);
  if (!isDateOnly(cutoff) || !Number.isFinite(end)) throw new Error('Choose a valid comparison date.');
  const boundary = Date.parse(`${cutoff}T00:00:00.000Z`);
  const before = emptyTotals();
  const after = emptyTotals();
  const seen = new Set<string>();
  const monthly = new Map<string, MonthTotal>();
  let first = Infinity;

  for (const commit of commits) {
    const date = Date.parse(commit.committedDate);
    if (
      !commit.oid || seen.has(commit.oid) || commit.authorId !== userId ||
      !Number.isInteger(commit.parentCount) || commit.parentCount < 0 || commit.parentCount > 1 ||
      !integer(commit.additions) || !integer(commit.deletions) || !Number.isFinite(date) || date > end
    ) continue;
    seen.add(commit.oid);
    first = Math.min(first, date);
    const period = date < boundary ? 'before' : 'after';
    const totals = period === 'before' ? before : after;
    totals.additions += commit.additions;
    totals.deletions += commit.deletions;
    totals.commits += 1;
    if (!Number.isSafeInteger(totals.additions) || !Number.isSafeInteger(totals.deletions)) {
      throw new Error('This history is too large to total safely.');
    }
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
    before, after, months, cutoff, asOf: new Date(end).toISOString(), coverage,
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
