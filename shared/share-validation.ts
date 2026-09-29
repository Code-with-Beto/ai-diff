import type { CommitFilterSummary, Coverage, FileFilterSummary, LineTotals, ShareResult, Totals } from './types.ts';
import { isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from './analysis-rules.ts';

const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validTotals(value: unknown): value is Totals {
  if (!object(value) || !exactKeys(value, ['additions', 'deletions', 'commits'])) return false;
  return safeCount(value.additions) && safeCount(value.deletions) && safeCount(value.commits) &&
    (value.commits > 0 || (value.additions === 0 && value.deletions === 0));
}

function validLines(value: unknown): value is LineTotals {
  return object(value) && exactKeys(value, ['additions', 'deletions']) && safeCount(value.additions) && safeCount(value.deletions);
}

function validFileFilter(value: unknown): value is FileFilterSummary {
  if (!object(value) || !exactKeys(value, ['enabled', 'excludedBefore', 'excludedAfter', 'inspectedCommits', 'uninspectedBefore', 'uninspectedAfter'])) return false;
  if (typeof value.enabled !== 'boolean' || !safeCount(value.inspectedCommits) || !validLines(value.excludedBefore) || !validLines(value.excludedAfter) || !validTotals(value.uninspectedBefore) || !validTotals(value.uninspectedAfter)) return false;
  const removed = [value.excludedBefore, value.excludedAfter];
  if ((!value.enabled || value.inspectedCommits === 0) && removed.some(lines => lines.additions > 0 || lines.deletions > 0)) return false;
  return safeCount(value.inspectedCommits + value.uninspectedBefore.commits + value.uninspectedAfter.commits);
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
  const hasFileFilter = Object.hasOwn(value, 'fileFilter');
  if (!exactKeys(value, ['version', 'login', 'cutoff', 'asOf', 'firstCommitAt', 'before', 'after', 'coverage', 'includesPrivate', 'sample', ...(hasFilter ? ['commitFilter'] : []), ...(hasFileFilter ? ['fileFilter'] : [])])) return false;
  if (hasFilter && !validCommitFilter(value.commitFilter)) return false;
  if (hasFileFilter && !validFileFilter(value.fileFilter)) return false;
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
  if (hasFileFilter) {
    const files = value.fileFilter as FileFilterSummary;
    const size = value.commitFilter as CommitFilterSummary | undefined;
    const retainedCommits = before.commits + after.commits + (size?.excludedBefore.commits ?? 0) + (size?.excludedAfter.commits ?? 0);
    const unknownCommits = files.uninspectedBefore.commits + files.uninspectedAfter.commits;
    if (files.inspectedCommits + (files.enabled ? 0 : unknownCommits) !== retainedCommits) return false;
    if (value.coverage.total === 0 && files.inspectedCommits + unknownCommits > 0) return false;
    if (boundary > value.asOf && files.uninspectedAfter.commits > 0) return false;
    for (const [counted, sizeExcluded, removed, unknown] of [
      [before, size?.excludedBefore, files.excludedBefore, files.uninspectedBefore],
      [after, size?.excludedAfter, files.excludedAfter, files.uninspectedAfter],
    ] as const) {
      const inspectedInPeriod = counted.commits + (sizeExcluded?.commits ?? 0);
      if (files.enabled && inspectedInPeriod === 0 && (removed.additions > 0 || removed.deletions > 0)) return false;
      if (!files.enabled && unknown.commits > inspectedInPeriod) return false;
      for (const key of ['additions', 'deletions'] as const) {
        const periodLines = counted[key] + (sizeExcluded?.[key] ?? 0);
        if (!files.enabled && (unknown[key] > periodLines || (unknown.commits === inspectedInPeriod && unknown[key] !== periodLines))) return false;
      }
    }
    for (const key of ['additions', 'deletions', 'commits'] as const) {
      // Clean-mode omissions and removed lockfile lines are disjoint from the
      // counted totals and post-lockfile size exclusions. Raw mode already
      // includes uninspected commits, so never add them a second time.
      const removed = key === 'commits' ? 0 : files.excludedBefore[key] + files.excludedAfter[key];
      const omitted = files.enabled ? files.uninspectedBefore[key] + files.uninspectedAfter[key] : 0;
      if (!safeCount(before[key] + after[key] + (size?.excludedBefore[key] ?? 0) + (size?.excludedAfter[key] ?? 0) + removed + omitted)) return false;
    }
  }
  return true;
}
