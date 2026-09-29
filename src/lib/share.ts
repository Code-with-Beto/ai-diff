import type { AnalysisResult, CommitFilterSummary, Coverage, ShareResult, Totals } from '../../shared/types.ts';
import { formatDate, formatNumber, isDateOnly, OVERSIZED_COMMIT_THRESHOLD } from './analysis.ts';

export const MAX_SHARE_PAYLOAD_LENGTH = 6000;
const MAX_JSON_BYTES = 4096;
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

export function describeCommitFilter(filter?: CommitFilterSummary): string {
  if (!filter?.enabled) return 'All commit sizes included.';
  const excluded = filter.excludedBefore.commits + filter.excludedAfter.commits;
  return `Size filter: >${formatNumber(filter.threshold)} changed lines · ${formatNumber(excluded)} commit${excluded === 1 ? '' : 's'} excluded · ${filter.scope === 'both' ? 'both periods' : 'before only (unequal filter)'}`;
}

function validShare(value: unknown): value is ShareResult {
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

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Aggregate-only, unsigned snapshots. Never add tokens, repository names or raw commits. */
export function encodeShare(result: ShareResult): string {
  if (!validShare(result)) throw new Error('This result cannot be shared. Finish a valid analysis first.');
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  if (bytes.length > MAX_JSON_BYTES) throw new Error('This shared result is too large.');
  return toBase64Url(bytes);
}

export function decodeShare(fragment: string): ShareResult | null {
  const payload = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!payload || payload.length > MAX_SHARE_PAYLOAD_LENGTH || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    if (binary.length > MAX_JSON_BYTES) return null;
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (toBase64Url(bytes) !== payload) return null;
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return validShare(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createShareResult(login: string, result: AnalysisResult, sample = false): ShareResult {
  const snapshot: ShareResult = {
    version: 1, login, cutoff: result.cutoff, asOf: result.asOf, firstCommitAt: result.firstCommitAt,
    before: { ...result.before }, after: { ...result.after }, coverage: { ...result.coverage },
    includesPrivate: result.includesPrivate, sample,
    ...(result.commitFilter ? { commitFilter: {
      enabled: result.commitFilter.enabled, threshold: result.commitFilter.threshold, scope: result.commitFilter.scope,
      excludedBefore: { ...result.commitFilter.excludedBefore }, excludedAfter: { ...result.commitFilter.excludedAfter },
    } } : {}),
  };
  if (!validShare(snapshot)) throw new Error('This result cannot be shared. Finish a valid analysis first.');
  return snapshot;
}

export function createShareUrl(result: ShareResult, origin = window.location.origin): string {
  const url = new URL('/share', origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Sharing requires a web address.');
  url.hash = encodeShare(result);
  return url.toString();
}

export function createShareText(result: ShareResult): string {
  if (!validShare(result)) throw new Error('This result cannot be shared.');
  const cutoffTime = Date.parse(`${result.cutoff}T00:00:00.000Z`);
  const beforeEnd = new Date(Math.min(cutoffTime - 1, Date.parse(result.asOf))).toISOString();
  const beforeRange = result.before.commits > 0 && result.firstCommitAt
    ? `${formatDate(result.firstCommitAt)} – ${formatDate(beforeEnd)}`
    : `before ${formatDate(result.cutoff)}; no counted commits`;
  const afterRange = cutoffTime <= Date.parse(result.asOf)
    ? `${formatDate(result.cutoff)} – ${formatDate(result.asOf)}`
    : 'cutoff falls after this snapshot';
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  return [
    result.sample ? `Sample GitHub history for @${result.login} (fictional demo).` : `@${result.login}’s GitHub, before and after AI.`,
    `Before (${beforeRange}): ${formatNumber(result.before.additions)} lines added.`,
    `After (${afterRange}): ${formatNumber(result.after.additions)} lines added.`,
    `Cutoff: ${formatDate(result.cutoff)}, 00:00 UTC.`,
    `Coverage: ${result.coverage.completed}/${result.coverage.total} repositories complete${partial ? `; partial results (${result.coverage.incomplete} incomplete, ${result.coverage.unavailable} unavailable)` : ''}.`,
    result.includesPrivate ? `${result.sample ? 'Includes fictional private' : 'Includes private'} repository totals.` : 'Public repository totals only.',
    describeCommitFilter(result.commitFilter),
    'Different time spans. Self-reported Git activity, not a productivity measure or proof of AI use.',
    'Explore yours with AI Diff by Code with Beto: https://aidiff.cwb.sh',
  ].join('\n');
}

/** A comparison of added-line totals, without normalizing unequal time windows. */
export function describeAdditionChange(before: number, after: number): string {
  if (!safeCount(before) || !safeCount(after)) throw new Error('Added-line totals must be nonnegative safe integers.');
  if (before === 0 && after === 0) return 'No lines added in either period';
  if (before === after) return 'No change in lines added · 0%';
  const difference = after - before;
  const direction = difference > 0 ? 'more' : 'fewer';
  const amount = Math.abs(difference);
  const change = `${formatNumber(amount)} ${direction} ${amount === 1 ? 'line' : 'lines'} after`;
  if (before === 0) return `${change} · no before baseline`;
  const percentage = difference / before * 100;
  // Keep a real, small change visible instead of rounding it to +0% or −0%.
  const options: Intl.NumberFormatOptions = Math.abs(percentage) < 0.1
    ? { maximumSignificantDigits: 2, signDisplay: 'always' }
    : { maximumFractionDigits: 1, signDisplay: 'always' };
  const formatted = new Intl.NumberFormat('en-US', options).format(percentage).replace(/^-/, '−');
  return `${change} · ${formatted}%`;
}

export async function renderShareImage(result: ShareResult): Promise<Blob> {
  if (!validShare(result)) throw new Error('This result cannot be rendered.');
  await document.fonts?.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image export is unavailable in this browser.');
  const c = context;
  const colors = { background: '#0a0a0a', text: '#f5f5f5', before: '#bdbdbd', after: '#38bdf8', muted: '#a3a3a3', track: '#242424', quiet: '#969696' };
  c.fillStyle = colors.background;
  c.fillRect(0, 0, 1200, 630);

  const font = (size: number, weight: number) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const text = (value: string, x: number, y: number, size: number, color: string, weight = 400, maxWidth = 1088, minimumSize = 14) => {
    c.fillStyle = color;
    c.font = font(size, weight);
    while (c.measureText(value).width > maxWidth && size > minimumSize) {
      size -= 1;
      c.font = font(size, weight);
    }
    c.fillText(value, x, y);
  };
  const wrappedText = (value: string, y: number) => {
    const words = value.split(' ');
    const lines: string[] = [];
    let line = '';
    c.font = font(16, 400);
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && c.measureText(next).width > 1088 && lines.length === 0) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    lines.forEach((value, index) => text(value, 56, y + index * 20, 16, colors.muted));
    return y + lines.length * 20;
  };

  text(`AI Diff  /  @${result.login}${result.sample ? '  /  sample data' : ''}`, 56, 54, 19, colors.muted, 500);
  text('Lines added', 56, 119, 34, colors.text, 500);

  const cutoffTime = Date.parse(`${result.cutoff}T00:00:00.000Z`);
  const beforeEnd = new Date(Math.min(cutoffTime - 1, Date.parse(result.asOf))).toISOString();
  const maximum = Math.max(result.before.additions, result.after.additions);
  const barWidth = 504;
  for (const [index, period] of (['before', 'after'] as const).entries()) {
    const x = 56 + index * 584;
    const additions = result[period].additions;
    const color = period === 'after' ? colors.after : colors.before;
    text(period === 'before' ? 'Before' : 'After', x, 164, 18, color, 500, barWidth);
    text(formatNumber(additions), x, 256, 80, color, 500, barWidth, 28);
    const range = period === 'before'
      ? result.before.commits > 0 && result.firstCommitAt
        ? `${formatDate(result.firstCommitAt)} – ${formatDate(beforeEnd)}`
        : `No counted commits before ${formatDate(result.cutoff)}`
      : cutoffTime <= Date.parse(result.asOf)
        ? `${formatDate(result.cutoff)} – ${formatDate(result.asOf)}`
        : 'Cutoff falls after this snapshot';
    text(range, x, 293, 17, colors.muted, 400, barWidth);
    c.fillStyle = colors.track;
    c.fillRect(x, 320, barWidth, 14);
    // Both periods use one scale. Zero stays zero; tiny values are never inflated.
    if (maximum > 0 && additions > 0) {
      c.fillStyle = color;
      c.fillRect(x, 320, additions / maximum * barWidth, 14);
    }
  }

  text(describeAdditionChange(result.before.additions, result.after.additions), 56, 395, 26, colors.text, 500);
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  const coverage = `${result.coverage.completed}/${result.coverage.total} repositories complete${partial ? ` · partial (${result.coverage.incomplete} incomplete, ${result.coverage.unavailable} unavailable)` : ''}${result.includesPrivate ? ` · ${result.sample ? 'fictional private totals' : 'includes private totals'}` : ''}`;
  const filterY = wrappedText(coverage, 445);
  const filter = result.commitFilter;
  if (filter?.enabled && (filter.scope === 'before' || filter.excludedBefore.commits + filter.excludedAfter.commits > 0)) {
    wrappedText(describeCommitFilter(filter), filterY);
  }

  c.fillStyle = '#303030';
  c.fillRect(56, 521, 1088, 1);
  text('UTC dates · Unequal periods · Self-reported Git activity, not AI authorship or productivity.', 56, 552, 16, colors.quiet);
  text('aidiff.cwb.sh · Code with Beto', 842, 604, 16, colors.quiet, 400, 302);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create the image.')), 'image/png'));
}

export async function copyShareImage(blob: Blob): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('This browser cannot copy images. Download the image instead.');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export function downloadShareImage(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ai-diff-codewithbeto.png';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
