import type { AnalysisResult, Coverage, ShareResult, Totals } from '../../shared/types.ts';
import { formatDate, formatNumber, isDateOnly } from './analysis.ts';

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

function validShare(value: unknown): value is ShareResult {
  if (!object(value) || !exactKeys(value, ['version', 'login', 'cutoff', 'asOf', 'firstCommitAt', 'before', 'after', 'coverage', 'includesPrivate', 'sample'])) return false;
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
    'Different time spans. Self-reported Git activity, not a productivity measure or proof of AI use.',
    'Explore yours with AI Diff by Code with Beto: https://aidiff.cwb.sh',
  ].join('\n');
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
  c.fillStyle = '#0a0a0a';
  c.fillRect(0, 0, 1200, 630);
  const text = (value: string, x: number, y: number, size: number, color: string, weight = 400, maxWidth?: number) => {
    c.fillStyle = color;
    c.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    if (maxWidth) {
      while (c.measureText(value).width > maxWidth && size > 16) {
        size -= 1;
        c.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      }
    }
    c.fillText(value, x, y);
  };
  text('AI DIFF', 56, 73, 25, '#f5f5f5', 700);
  text(result.sample ? 'SAMPLE DATA' : 'SHARED SNAPSHOT', 894, 73, 17, '#f5f5f5', 650);
  text(`@${result.login}`, 56, 145, 49, '#f5f5f5', 650, 1088);
  text('My GitHub, before and after AI.', 57, 186, 27, '#a3a3a3');

  for (const [index, period] of (['before', 'after'] as const).entries()) {
    const x = 56 + index * 558;
    const totals = result[period];
    c.fillStyle = '#151515';
    c.beginPath();
    c.roundRect(x, 222, 530, 238, 8);
    c.fill();
    text(period === 'before' ? 'BEFORE' : 'AFTER', x + 27, 261, 16, period === 'after' ? '#f5f5f5' : '#a3a3a3', 650);
    text(formatNumber(totals.additions), x + 25, 337, 62, period === 'after' ? '#f5f5f5' : '#bdbdbd', 650, 478);
    text('lines added', x + 28, 371, 21, '#a3a3a3');
    text(`${formatNumber(totals.commits)} commits · ${formatNumber(totals.deletions)} deleted`, x + 28, 407, 18, '#d4d4d4', 400, 474);
    const range = period === 'before'
      ? totals.commits > 0 && result.firstCommitAt
        ? `${formatDate(result.firstCommitAt)} – ${formatDate(new Date(Date.parse(`${result.cutoff}T00:00:00.000Z`) - 1).toISOString())}`
        : `Before ${formatDate(result.cutoff)}`
      : `${formatDate(result.cutoff)} – ${formatDate(result.asOf)}`;
    text(range, x + 28, 438, 16, '#a3a3a3', 400, 474);
  }
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  const coverage = `${result.coverage.completed}/${result.coverage.total} repositories complete${partial ? ' · partial results' : ''}${result.includesPrivate ? ' · includes private' : ''}`;
  text(coverage, 56, 493, 19, '#a3a3a3', 400, 1088);
  c.fillStyle = '#303030';
  c.fillRect(56, 531, 1088, 1);
  text('Git additions, not proof of AI use. Shared numbers are self-reported.', 56, 568, 17, '#969696', 400, 1088);
  text(result.sample ? 'Illustrative sample. Not a real account analysis.' : `Snapshot as of ${formatDate(result.asOf)} · Compared using commit dates (UTC)`, 56, 600, 15, '#969696');
  text('aidiff.cwb.sh · Code with Beto', 842, 600, 16, '#a3a3a3', 400);
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
