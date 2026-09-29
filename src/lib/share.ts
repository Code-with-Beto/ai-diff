import type { AnalysisResult, CommitFilterSummary, FileFilterSummary, ShareResult } from '../../shared/types.ts';
import { formatDate, formatNumber } from './analysis.ts';

import { isShareResult as validShare } from '../../shared/share-validation.ts';

export const MAX_SHARE_PAYLOAD_LENGTH = 6000;
const MAX_JSON_BYTES = 4096;
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function describeCommitFilter(filter?: CommitFilterSummary): string {
  if (!filter?.enabled) return 'All commit sizes included.';
  const excluded = filter.excludedBefore.commits + filter.excludedAfter.commits;
  return `Size filter: >${formatNumber(filter.threshold)} changed lines · ${formatNumber(excluded)} commit${excluded === 1 ? '' : 's'} excluded · ${filter.scope === 'both' ? 'both periods' : 'before only (unequal filter)'}`;
}

export function describeFileFilter(filter: FileFilterSummary): string {
  const incomplete = filter.uninspectedBefore.commits + filter.uninspectedAfter.commits;
  const inspection = `File inspection: ${formatNumber(filter.inspectedCommits)} complete, ${formatNumber(incomplete)} incomplete.`;
  if (!filter.enabled) return `Dependency lockfiles/checksums included. ${inspection} Uninspected commits retain raw line counts, subject to the size filter.`;
  const removed = `Dependency lockfiles/checksums excluded in both periods: before ${formatNumber(filter.excludedBefore.additions)} additions / ${formatNumber(filter.excludedBefore.deletions)} deletions; after ${formatNumber(filter.excludedAfter.additions)} additions / ${formatNumber(filter.excludedAfter.deletions)} deletions.`;
  return `${removed} ${inspection}${incomplete > 0 ? ` Partial results: uninspected commits omitted (${formatNumber(filter.uninspectedBefore.commits)} before, ${formatNumber(filter.uninspectedAfter.commits)} after).` : ''}`;
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
    ...(result.fileFilter ? { fileFilter: {
      enabled: result.fileFilter.enabled,
      excludedBefore: { additions: result.fileFilter.excludedBefore.additions, deletions: result.fileFilter.excludedBefore.deletions },
      excludedAfter: { additions: result.fileFilter.excludedAfter.additions, deletions: result.fileFilter.excludedAfter.deletions },
      inspectedCommits: result.fileFilter.inspectedCommits,
      uninspectedBefore: { additions: result.fileFilter.uninspectedBefore.additions, deletions: result.fileFilter.uninspectedBefore.deletions, commits: result.fileFilter.uninspectedBefore.commits },
      uninspectedAfter: { additions: result.fileFilter.uninspectedAfter.additions, deletions: result.fileFilter.uninspectedAfter.deletions, commits: result.fileFilter.uninspectedAfter.commits },
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
    ...(result.fileFilter ? [describeFileFilter(result.fileFilter)] : []),
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

export type ShareImageTheme = 'light' | 'dark';

export async function renderShareImage(result: ShareResult, theme: ShareImageTheme = 'dark'): Promise<Blob> {
  if (!validShare(result)) throw new Error('This result cannot be rendered.');
  await document.fonts?.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 600;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image export is unavailable in this browser.');
  const c = context;
  const colors = theme === 'light'
    ? { background: '#fafafa', text: '#171717', before: '#666', after: '#0ea5e9', muted: '#666', track: '#e5e5e5' }
    : { background: '#0a0a0a', text: '#ededed', before: '#a3a3a3', after: '#38bdf8', muted: '#a3a3a3', track: '#242424' };
  c.fillStyle = colors.background;
  c.fillRect(0, 0, 1200, 600);

  const font = (size: number, weight: number) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  const text = (value: string, x: number, y: number, size: number, color: string, weight = 400, maxWidth = 1088, minimumSize = 14, align: 'left' | 'center' | 'right' = 'left') => {
    c.fillStyle = color;
    c.font = font(size, weight);
    while (c.measureText(value).width > maxWidth && size > minimumSize) {
      size -= 1;
      c.font = font(size, weight);
    }
    const width = c.measureText(value).width;
    c.fillText(value, x - (align === 'center' ? width / 2 : align === 'right' ? width : 0), y);
  };
  const wrappedContext = (value: string) => {
    const words = value.split(' ');
    let lines: string[] = [];
    let size = 17;
    do {
      size -= 1;
      c.font = font(size, 400);
      lines = [];
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && c.measureText(next).width > 1088) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
    } while (lines.length > 3 && size > 14);
    lines.forEach((value, index) => text(value, 600, 480 + index * 22, size, colors.muted, 400, 1088, 14, 'center'));
  };

  text(`@${result.login}`, 56, 64, 22, colors.text, 550);
  if (result.sample) text('Sample data · fictional account', 56, 94, 16, colors.muted);

  const cutoffTime = Date.parse(`${result.cutoff}T00:00:00.000Z`);
  const beforeEnd = new Date(Math.min(cutoffTime - 1, Date.parse(result.asOf))).toISOString();
  const total = result.before.additions + result.after.additions;
  const columnWidth = 504;
  let numberSize = 108;
  c.font = font(numberSize, 700);
  while (Math.max(...[result.before.additions, result.after.additions].map(value => c.measureText(formatNumber(value)).width)) > columnWidth && numberSize > 28) {
    numberSize -= 1;
    c.font = font(numberSize, 700);
  }
  for (const [index, period] of (['before', 'after'] as const).entries()) {
    // Match the website's label, total, unit and date hierarchy in equal columns.
    const x = 56 + index * 584;
    const additions = result[period].additions;
    text(period === 'before' ? 'Before' : 'After', x, 162, 22, colors.muted);
    text(formatNumber(additions), x, 276, numberSize, period === 'before' ? colors.before : colors.text, 700, columnWidth, 28);
    text('lines added', x, 324, 20, colors.muted);
    const range = period === 'before'
      ? result.before.commits > 0 && result.firstCommitAt
        ? `${formatDate(result.firstCommitAt)} – ${formatDate(beforeEnd)}`
        : `Before ${formatDate(result.cutoff)}`
      : cutoffTime <= Date.parse(result.asOf)
        ? `${formatDate(result.cutoff)} – ${formatDate(result.asOf)}`
        : 'Cutoff falls after this snapshot';
    text(range, x, 364, 20, colors.muted, 400, columnWidth);
  }

  const barWidth = 1088;
  c.fillStyle = colors.track;
  c.fillRect(56, 412, barWidth, 6);
  // One continuous bar represents the combined total. Empty periods stay empty.
  if (total > 0) {
    const beforeWidth = result.before.additions / total * barWidth;
    if (result.before.additions > 0) {
      c.fillStyle = colors.before;
      c.fillRect(56, 412, beforeWidth, 6);
    }
    if (result.after.additions > 0) {
      c.fillStyle = colors.after;
      c.fillRect(56 + beforeWidth, 412, barWidth - beforeWidth, 6);
    }
  }

  const fileFilter = result.fileFilter;
  const incompleteFiles = fileFilter?.enabled ? fileFilter.uninspectedBefore.commits + fileFilter.uninspectedAfter.commits : 0;
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0 || incompleteFiles > 0;
  const contextParts = [
    `${partial ? 'Partial · ' : ''}${result.coverage.completed}/${result.coverage.total} repos complete`,
    ...(result.includesPrivate ? ['Includes private totals'] : []),
  ];
  const filter = result.commitFilter;
  if (filter?.enabled) {
    const excluded = filter.excludedBefore.commits + filter.excludedAfter.commits;
    if (filter.scope === 'before' || excluded > 0) {
      contextParts.push(`${formatNumber(excluded)} commit${excluded === 1 ? '' : 's'} excluded (>100k changed lines; ${filter.scope === 'before' ? 'before only, unequal filter' : 'both periods'})`);
    }
  }
  if (fileFilter) {
    contextParts.push(`Lockfiles/checksums ${fileFilter.enabled ? 'excluded' : 'included'}`);
    if (incompleteFiles > 0) contextParts.push(`Uninspected commits omitted: ${formatNumber(fileFilter.uninspectedBefore.commits)} before / ${formatNumber(fileFilter.uninspectedAfter.commits)} after`);
  }
  wrappedContext(contextParts.join(' · '));
  text('aidiff.cwb.sh · Code with Beto', 600, 552, 18, colors.muted, 400, 1088, 14, 'center');
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
