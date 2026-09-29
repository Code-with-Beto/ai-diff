import type { CommitFilterSummary, Coverage, ShareResult, Totals } from './types.ts';
import { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from './analysis-rules.ts';

const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validTotals(value: unknown): value is Totals {
  if (!object(value) || !exactKeys(value, ['additions', 'deletions', 'commits'])) return false;
  return safeCount(value.additions) && safeCount(value.deletions) && safeCount(value.commits) &&
    (value.commits > 0 || (value.additions === 0 && value.deletions === 0));
}

function validCoverage(value: unknown): value is Coverage {
  if (!object(value) || !exactKeys(value, ['completed', 'unavailable', 'incomplete', 'total'])) return false;
  return safeCount(value.completed) && safeCount(value.unavailable) && safeCount(value.incomplete) && safeCount(value.total) &&
    value.total <= 100000 && value.completed + value.unavailable + value.incomplete === value.total;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value && parsed.getUTCFullYear() >= 1970 && parsed.getUTCFullYear() <= 2100;
}

function validCommitFilter(value: unknown): value is CommitFilterSummary {
  if (!object(value) || !exactKeys(value, ['enabled', 'threshold', 'scope', 'excludedBefore', 'excludedAfter'])) return false;
  if (typeof value.enabled !== 'boolean' || value.threshold !== OVERSIZED_COMMIT_THRESHOLD || !['both', 'before'].includes(value.scope as string)) return false;
  if (!validTotals(value.excludedBefore) || !validTotals(value.excludedAfter)) return false;
  if (!value.enabled && (value.excludedBefore.commits > 0 || value.excludedAfter.commits > 0)) return false;
  if (value.scope === 'before' && value.excludedAfter.commits > 0) return false;
  for (const totals of [value.excludedBefore, value.excludedAfter]) {
    if (totals.commits > 0 && (totals.additions + totals.deletions) / totals.commits <= OVERSIZED_COMMIT_THRESHOLD) return false;
  }
  return true;
}

export function isShareResult(value: unknown): value is ShareResult {
  if (!object(value)) return false;
  const hasFilter = Object.hasOwn(value, 'commitFilter');
  if (!exactKeys(value, ['version', 'login', 'cutoff', 'asOf', 'firstCommitAt', 'before', 'after', 'coverage', 'includesPrivate', 'sample', ...(hasFilter ? ['commitFilter'] : [])])) return false;
  if (hasFilter && !validCommitFilter(value.commitFilter)) return false;
  if (value.version !== 1 || typeof value.login !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.login) || value.login.includes('--')) return false;
  if (typeof value.cutoff !== 'string' || !isDateOnly(value.cutoff) || value.cutoff < '1970-01-01' || value.cutoff > '2100-12-31') return false;
  if (!validTimestamp(value.asOf) || !validTotals(value.before) || !validTotals(value.after) || !validCoverage(value.coverage)) return false;
  if (typeof value.includesPrivate !== 'boolean' || typeof value.sample !== 'boolean') return false;
  const before = value.before;
  const after = value.after;
  if (!safeCount(before.additions + after.additions) || !safeCount(before.deletions + after.deletions) || !safeCount(before.commits + after.commits)) return false;
  if (value.firstCommitAt !== null && (!validTimestamp(value.firstCommitAt) || value.firstCommitAt > value.asOf)) return false;
  if ((before.commits + after.commits === 0) !== (value.firstCommitAt === null)) return false;
  const boundary = `${value.cutoff}T00:00:00.000Z`;
  if (after.commits > 0 && boundary > value.asOf) return false;
  if (before.commits > 0 && (value.firstCommitAt === null || value.firstCommitAt >= boundary)) return false;
  if (before.commits === 0 && value.firstCommitAt !== null && value.firstCommitAt < boundary) return false;
  if (value.coverage.total === 0 && before.commits + after.commits > 0) return false;
  if (hasFilter) {
    const filter = value.commitFilter as CommitFilterSummary;
    for (const key of ['additions', 'deletions', 'commits'] as const) {
      if (!safeCount(before[key] + after[key] + filter.excludedBefore[key] + filter.excludedAfter[key])) return false;
    }
    if (value.coverage.total === 0 && filter.excludedBefore.commits + filter.excludedAfter.commits > 0) return false;
    if (filter.excludedAfter.commits > 0 && boundary > value.asOf) return false;
  }
  return true;
}
