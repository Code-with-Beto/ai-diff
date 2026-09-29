import { describe, expect, it, vi } from 'vitest';
import { createShareResult, createShareText, createShareUrl, decodeShare, describeAdditionChange, encodeShare, MAX_SHARE_PAYLOAD_LENGTH, renderShareImage } from '../src/lib/share.ts';
import { analyzeCommits } from '../src/lib/analysis.ts';
import type { ShareResult } from '../shared/types.ts';

const fixture: ShareResult = {
  version: 1, login: 'octo-dev', cutoff: '2025-09-29', asOf: '2026-09-29T12:00:00.000Z',
  firstCommitAt: '2019-01-01T00:00:00.000Z', before: { additions: 20000, deletions: 2000, commits: 100 },
  after: { additions: 60000, deletions: 15000, commits: 200 },
  coverage: { completed: 3, unavailable: 1, incomplete: 2, total: 6 }, includesPrivate: true, sample: false,
};
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function recordImage(snapshot: ShareResult) {
  const labels: { value: string; x: number; y: number; size: number; weight: number; width: number; color: string }[] = [];
  const rectangles: { x: number; y: number; width: number; height: number; color: string }[] = [];
  const context = {
    fillStyle: '', font: '',
    measureText(value: string) { return { width: value.length * Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16) * 0.6 }; },
    fillText(value: string, x: number, y: number) { labels.push({ value, x, y, size: Number(this.font.match(/([\d.]+)px/)?.[1]), weight: Number(this.font.split(' ')[0]), width: this.measureText(value).width, color: this.fillStyle }); },
    fillRect(x: number, y: number, width: number, height: number) { rectangles.push({ x, y, width, height, color: this.fillStyle }); },
  };
  const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: (value: Blob) => void) => callback(new Blob(['image'], { type: 'image/png' })) };
  vi.stubGlobal('document', { fonts: { ready: Promise.resolve() }, createElement: () => canvas });
  try { const blob = await renderShareImage(snapshot); return { labels, rectangles, width: canvas.width, height: canvas.height, blob }; }
  finally { vi.unstubAllGlobals(); }
}

describe('aggregate sharing', () => {
  it('round-trips bounded aggregates and accepts the browser hash without leaking query values', () => {
    expect(decodeShare(encodeShare(fixture))).toEqual(fixture);
    const url = new URL(createShareUrl(fixture, 'https://example.test/path?unrelated=1'));
    expect(url.pathname).toBe('/share');
    expect(url.search).toBe('');
    expect(decodeShare(url.hash)).toEqual(fixture);
  });

  it('includes only aggregate fields in the snapshot', () => {
    const result = analyzeCommits([], 'dev', '2025-09-29', fixture.asOf, []);
    const snapshot = createShareResult('octo-dev', result, true);
    expect(Object.keys(snapshot).sort()).toEqual([...Object.keys(fixture), 'commitFilter'].sort());
    expect(snapshot.sample).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('months');
    expect(decodeShare(encodeShare(snapshot))).toEqual(snapshot);
  });

  it.each(['', '#', 'not valid!', '%%%%', 'a', '#eyJ9', 'A'.repeat(MAX_SHARE_PAYLOAD_LENGTH + 1), raw('hello'), raw(null), raw([])])('rejects malformed or oversized payload %s', payload => {
    expect(decodeShare(payload)).toBeNull();
  });

  it('rejects noncanonical base64, malformed UTF-8 and JSON padding attacks', () => {
    expect(decodeShare(encodeShare(fixture) + '=')).toBeNull();
    expect(decodeShare('_w')).toBeNull();
    expect(decodeShare(Buffer.from(' '.repeat(4200) + JSON.stringify(fixture)).toString('base64url'))).toBeNull();
  });

  it.each([
    { ...fixture, version: 2 },
    { ...fixture, login: '<script>alert(1)</script>' },
    { ...fixture, login: 'a'.repeat(40) },
    { ...fixture, login: 'two--hyphens' },
    { ...fixture, cutoff: '2025-02-30' },
    { ...fixture, asOf: 'yesterday' },
    { ...fixture, asOf: '2026-02-30T12:00:00.000Z' },
    { ...fixture, firstCommitAt: '2027-01-01T00:00:00.000Z' },
    { ...fixture, firstCommitAt: null },
    { ...fixture, firstCommitAt: '2025-10-01T00:00:00.000Z' },
    { ...fixture, cutoff: '2027-01-01' },
    { ...fixture, sample: 'false' },
    { ...fixture, includesPrivate: null },
    { ...fixture, token: 'secret' },
    { ...fixture, before: { ...fixture.before, additions: -1 } },
    { ...fixture, before: { ...fixture.before, additions: 0.5 } },
    { ...fixture, before: { ...fixture.before, additions: Number.MAX_SAFE_INTEGER + 1 } },
    { ...fixture, before: { ...fixture.before, additions: Number.MAX_SAFE_INTEGER } },
    { ...fixture, before: { ...fixture.before, commits: 0 } },
    { ...fixture, before: { ...fixture.before, repository: 'private/name' } },
    { ...fixture, coverage: { ...fixture.coverage, total: 8 } },
    { ...fixture, coverage: { completed: 0, unavailable: 0, incomplete: 0, total: 0 } },
    { ...fixture, coverage: { completed: 100001, unavailable: 0, incomplete: 0, total: 100001 } },
  ])('rejects tampered or inconsistent field structures %#', candidate => {
    expect(decodeShare(raw(candidate))).toBeNull();
    expect(() => encodeShare(candidate as ShareResult)).toThrow();
  });

  it('rejects non-finite values at encoding even though JSON would replace them with null', () => {
    expect(() => encodeShare({ ...fixture, after: { ...fixture.after, additions: Infinity } })).toThrow();
    expect(() => encodeShare({ ...fixture, after: { ...fixture.after, additions: NaN } })).toThrow();
  });

  it('preserves valid partial coverage and zero-addition commits', () => {
    const value = { ...fixture, after: { additions: 0, deletions: 400, commits: 3 } };
    expect(decodeShare(encodeShare(value))).toEqual(value);
  });

  it('does not imply cryptographic verification: structurally valid edits remain self-reported', () => {
    const edited = { ...fixture, after: { ...fixture.after, additions: 999999 } };
    expect(decodeShare(raw(edited))).toEqual(edited);
  });

  it('shares truthful partial sample/private text with real ranges and a canonical tool link', () => {
    const text = createShareText({ ...fixture, sample: true });
    expect(text.split('\n')).toHaveLength(9);
    expect(text).not.toContain('\\n');
    expect(text).toContain('Sample GitHub history for @octo-dev (fictional demo).');
    expect(text).toContain('Before (Jan 1, 2019 – Sep 28, 2025): 20,000 lines added.');
    expect(text).toContain('After (Sep 29, 2025 – Sep 29, 2026): 60,000 lines added.');
    expect(text).toContain('Cutoff: Sep 29, 2025, 00:00 UTC.');
    expect(text).toContain('3/6 repositories complete; partial results (2 incomplete, 1 unavailable)');
    expect(text).toContain('Includes fictional private repository totals.');
    expect(text).toContain('Different time spans. Self-reported Git activity, not a productivity measure or proof of AI use.');
    expect(text).toContain('https://aidiff.cwb.sh');
    expect(text).not.toContain('/share#');
    expect(text).not.toContain(encodeShare(fixture));
    expect(createShareText(fixture)).toContain('Includes private repository totals.');
  });
});

describe('added-line change wording', () => {
  it.each([
    [20_000, 60_000, '40,000 more lines after · +200%'],
    [60_000, 20_000, '40,000 fewer lines after · −66.7%'],
    [20_000, 0, '20,000 fewer lines after · −100%'],
    [20_000, 20_000, 'No change in lines added · 0%'],
    [0, 60_000, '60,000 more lines after · no before baseline'],
    [0, 0, 'No lines added in either period'],
  ])('describes %i before and %i after accurately', (before, after, expected) => {
    expect(describeAdditionChange(before, after)).toBe(expected);
  });

  it('does not round a real small change down to zero or accept invalid counts', () => {
    expect(describeAdditionChange(1_000_000, 1_000_001)).toBe('1 more line after · +0.0001%');
    expect(describeAdditionChange(1_000_000, 999_999)).toBe('1 fewer line after · −0.0001%');
    expect(() => describeAdditionChange(-1, 2)).toThrow();
    expect(() => describeAdditionChange(1, Infinity)).toThrow();
  });
});

describe('share image comparison', () => {
  it('exports a 2:1 PNG with equally prominent bold neutral totals', async () => {
    const image = await recordImage(fixture);
    expect([image.width, image.height]).toEqual([1200, 600]);
    expect(image.width / image.height).toBe(2);
    expect(image.blob.type).toBe('image/png');
    const numbers = image.labels.filter(label => label.value === '20,000' || label.value === '60,000');
    expect(numbers).toHaveLength(2);
    expect(numbers[0].size).toBe(108);
    expect(numbers[1].size).toBe(numbers[0].size);
    for (const label of numbers) {
      expect(label.weight).toBeGreaterThanOrEqual(700);
      expect(label.color).toBe('#f5f5f5');
    }
    expect(numbers[0].x + numbers[0].width).toBeLessThan(600);
    expect(numbers[1].x).toBeGreaterThan(600);
    expect(image.labels.some(label => label.color === '#38bdf8')).toBe(false);
    const unequalDigits = await recordImage({ ...fixture, before: { ...fixture.before, additions: 1_000_000 }, after: { ...fixture.after, additions: 50 } });
    const longNumber = unequalDigits.labels.find(label => label.value === '1,000,000');
    const shortNumber = unequalDigits.labels.find(label => label.value === '50');
    expect(longNumber?.size).toBe(shortNumber?.size);
  });

  it.each([[20_000, 60_000], [60_000, 20_000], [20_000, 20_000]])('renders %i before and %i after on exactly the same bar scale', async (before, after) => {
    const rendered = await recordImage({ ...fixture, before: { ...fixture.before, additions: before }, after: { ...fixture.after, additions: after } });
    const tracks = rendered.rectangles.filter(rectangle => rectangle.color === '#242424');
    const beforeBar = rendered.rectangles.find(rectangle => rectangle.color === '#bdbdbd');
    const afterBar = rendered.rectangles.find(rectangle => rectangle.color === '#38bdf8');
    expect(tracks).toHaveLength(2);
    expect(tracks[0].width).toBe(tracks[1].width);
    expect(beforeBar?.width).toBeCloseTo(before / Math.max(before, after) * tracks[0].width);
    expect(afterBar?.width).toBeCloseTo(after / Math.max(before, after) * tracks[0].width);
    expect(beforeBar?.width! / afterBar?.width!).toBeCloseTo(before / after);
    expect(tracks.every(track => track.height === 6)).toBe(true);
    expect(rendered.labels.map(label => label.value)).not.toContain(describeAdditionChange(before, after));
  });

  it('draws no artificial bar for zero totals and handles a missing baseline', async () => {
    const zero = { ...fixture, before: { additions: 0, deletions: 0, commits: 0 }, after: { additions: 0, deletions: 0, commits: 0 }, firstCommitAt: null };
    const empty = await recordImage(zero);
    expect(empty.rectangles.filter(rectangle => rectangle.color === '#bdbdbd' || rectangle.color === '#38bdf8')).toEqual([]);
    expect(empty.labels.filter(label => label.value === '0')).toHaveLength(2);
    const afterOnly = await recordImage({ ...zero, after: { additions: 50, deletions: 0, commits: 1 }, firstCommitAt: '2025-09-29T12:00:00.000Z' });
    expect(afterOnly.rectangles.some(rectangle => rectangle.color === '#bdbdbd')).toBe(false);
    expect(afterOnly.labels.map(label => label.value)).toContain('50');
    expect(afterOnly.rectangles.find(rectangle => rectangle.color === '#38bdf8')?.width).toBe(504);
  });

  it('keeps one units heading, actual ranges and the necessary disclosures without old detail clutter', async () => {
    const { labels } = await recordImage({ ...fixture, sample: true });
    const values = labels.map(label => label.value);
    expect(values.filter(value => value === 'Lines added')).toHaveLength(1);
    expect(values).toContain('Before');
    expect(values).toContain('After');
    expect(values).toContain('Jan 1, 2019 – Sep 28, 2025');
    expect(values).toContain('Sep 29, 2025 – Sep 29, 2026');
    expect(values.join(' ')).toContain('Partial · 3/6 repos complete');
    expect(values.join(' ')).toContain('Includes private totals');
    expect(values.join(' ')).toContain('Sample data');
    expect(values).toContain('aidiff.cwb.sh · Code with Beto');
    expect(values.join(' ')).not.toMatch(/SHARED SNAPSHOT|My GitHub|commits · .*deleted|All commit sizes|Illustrative sample|Snapshot as of|Self-reported|authorship|productivity|%/);
    expect(values).toHaveLength(10);
  });

  it('only adds filter context when it changed totals or treats the periods differently', async () => {
    const zero = { additions: 0, deletions: 0, commits: 0 };
    const filter = { enabled: true, threshold: 100_000, scope: 'both' as const, excludedBefore: zero, excludedAfter: zero };
    const unchanged = await recordImage({ ...fixture, commitFilter: filter });
    expect(unchanged.labels.some(label => label.value.includes('excluded'))).toBe(false);
    const unequal = await recordImage({ ...fixture, commitFilter: { ...filter, scope: 'before' } });
    expect(unequal.labels.map(label => label.value).join(' ')).toContain('0 commits excluded (>100k changed lines; before only, unequal filter)');
    const changed = await recordImage({ ...fixture, commitFilter: { ...filter, excludedAfter: { additions: 100_001, deletions: 0, commits: 1 } } });
    expect(changed.labels.map(label => label.value).join(' ')).toContain('1 commit excluded (>100k changed lines; both periods)');
  });

  it('fits long handles, maximum safe totals and long filter disclosures without overlap', async () => {
    const large: ShareResult = {
      ...fixture, login: 'a'.repeat(39),
      before: { additions: 4_503_599_627_370_495, deletions: 0, commits: 1 },
      after: { additions: 4_503_599_627_370_496, deletions: 0, commits: 1 },
    };
    const filtered: ShareResult = {
      ...fixture, login: 'b'.repeat(39), sample: true,
      coverage: { completed: 1, unavailable: 49999, incomplete: 50000, total: 100000 },
      commitFilter: {
        enabled: true, threshold: 100000, scope: 'both',
        excludedBefore: { additions: 4_100_000_000_000_000, deletions: 0, commits: 40_000_000_000 },
        excludedAfter: { additions: 4_100_000_000_000_000, deletions: 0, commits: 40_000_000_000 },
      },
    };
    const unequal: ShareResult = { ...filtered, commitFilter: { ...filtered.commitFilter!, scope: 'before', excludedAfter: { additions: 0, deletions: 0, commits: 0 } } };
    for (const snapshot of [large, filtered, unequal]) {
      const { labels } = await recordImage(snapshot);
      for (const label of labels) {
        expect(label.x).toBeGreaterThanOrEqual(56);
        expect(label.x + label.width).toBeLessThanOrEqual(1144);
        expect(label.y - label.size).toBeGreaterThanOrEqual(0);
        expect(label.y + label.size * 0.2).toBeLessThan(600);
        expect(label.size).toBeGreaterThanOrEqual(14);
      }
      for (let index = 0; index < labels.length; index++) {
        for (const other of labels.slice(index + 1)) {
          const label = labels[index];
          const horizontal = label.x < other.x + other.width && other.x < label.x + label.width;
          const vertical = label.y - label.size < other.y + other.size * 0.2 && other.y - other.size < label.y + label.size * 0.2;
          expect(horizontal && vertical, `Text overlap: ${label.value} / ${other.value}`).toBe(false);
        }
      }
    }
  });
});
