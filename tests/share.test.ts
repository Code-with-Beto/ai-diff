import { describe, expect, it, vi } from 'vitest';
import { createShareResult, createShareText, createShareUrl, decodeShare, describeAdditionChange, encodeShare, MAX_SHARE_PAYLOAD_LENGTH, renderShareImage } from '../src/lib/share.ts';
import type { ShareImageTheme } from '../src/lib/share.ts';
import { analyzeCommits } from '../src/lib/analysis.ts';
import type { AnalysisResult, ShareResult } from '../shared/types.ts';

const fixture: ShareResult = {
  version: 1, login: 'octo-dev', cutoff: '2025-09-29', asOf: '2026-09-29T12:00:00.000Z',
  firstCommitAt: '2019-01-01T00:00:00.000Z', before: { additions: 20000, deletions: 2000, commits: 100 },
  after: { additions: 60000, deletions: 15000, commits: 200 },
  coverage: { completed: 3, unavailable: 1, incomplete: 2, total: 6 }, includesPrivate: true, sample: false,
};
const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const cleanFixture: ShareResult = {
  ...fixture, coverage: { completed: 6, unavailable: 0, incomplete: 0, total: 6 },
  fileFilter: {
    enabled: true, excludedBefore: { additions: 400, deletions: 100 }, excludedAfter: { additions: 800, deletions: 200 }, inspectedCommits: 300,
    uninspectedBefore: { additions: 1_000, deletions: 10, commits: 2 }, uninspectedAfter: { additions: 0, deletions: 0, commits: 0 },
  },
};

async function recordImage(snapshot: ShareResult, theme?: ShareImageTheme) {
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
  try { const blob = await renderShareImage(snapshot, theme); return { labels, rectangles, width: canvas.width, height: canvas.height, blob }; }
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

describe('file-filter aggregate sharing', () => {
  it('round-trips clean and raw inspection summaries while preserving legacy snapshots unchanged', () => {
    const rawSnapshot: ShareResult = { ...cleanFixture, fileFilter: { ...cleanFixture.fileFilter!, enabled: false, inspectedCommits: 298, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 } } };
    for (const value of [fixture, cleanFixture, rawSnapshot]) expect(decodeShare(encodeShare(value))).toEqual(value);
    expect(decodeShare(encodeShare(fixture))).not.toHaveProperty('fileFilter');
  });

  it('copies only aggregate fields even when analysis contains private drilldown records', () => {
    const analysis = {
      ...cleanFixture, months: [{ month: '2025-01', before: 1, after: 0 }], ratio: 3,
      details: [{ oid: 'private-sha', headline: 'private-headline', files: [{ filename: 'secret/package-lock.json', patch: 'private-source' }], repository: { nameWithOwner: 'secret/repository' } }],
      fileFilter: { ...cleanFixture.fileFilter!, filename: 'secret/yarn.lock', excludedBefore: { ...cleanFixture.fileFilter!.excludedBefore, filename: 'secret/go.sum' } },
    } as unknown as AnalysisResult;
    const snapshot = createShareResult('octo-dev', analysis);
    expect(snapshot.fileFilter).toEqual(cleanFixture.fileFilter);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private-sha|private-headline|private-source|filename|headline|months|details/);
    expect(snapshot.fileFilter).not.toBe(analysis.fileFilter);
    expect(snapshot.fileFilter?.uninspectedBefore).not.toBe(analysis.fileFilter?.uninspectedBefore);
  });

  it('accepts disjoint lockfile removals, remaining-size exclusions, and uninspected raw omissions', () => {
    const value: ShareResult = {
      ...cleanFixture,
      commitFilter: { enabled: true, threshold: 100_000, scope: 'both', excludedBefore: { additions: 100_001, deletions: 0, commits: 1 }, excludedAfter: { additions: 0, deletions: 0, commits: 0 } },
      fileFilter: { ...cleanFixture.fileFilter!, inspectedCommits: 301 },
    };
    expect(decodeShare(encodeShare(value))).toEqual(value);
    const allUninspected: ShareResult = { ...cleanFixture, firstCommitAt: null, before: { additions: 0, deletions: 0, commits: 0 }, after: { additions: 0, deletions: 0, commits: 0 }, fileFilter: { ...cleanFixture.fileFilter!, inspectedCommits: 0, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 } } };
    expect(decodeShare(encodeShare(allUninspected))).toEqual(allUninspected);
    const lockfilesOnly: ShareResult = { ...cleanFixture, before: { ...cleanFixture.before, additions: 0, deletions: 0 }, after: { ...cleanFixture.after, additions: 0, deletions: 0 } };
    expect(decodeShare(encodeShare(lockfilesOnly))).toEqual(lockfilesOnly);
  });

  it.each([
    null,
    { ...cleanFixture.fileFilter, enabled: 'true' },
    { ...cleanFixture.fileFilter, enabled: false },
    { ...cleanFixture.fileFilter, inspectedCommits: 299 },
    { ...cleanFixture.fileFilter, inspectedCommits: Infinity },
    { ...cleanFixture.fileFilter, inspectedCommits: 0 },
    { ...cleanFixture.fileFilter, filename: 'secret/yarn.lock' },
    { ...cleanFixture.fileFilter, excludedBefore: { additions: 1, deletions: 0, filename: 'secret/yarn.lock' } },
    { ...cleanFixture.fileFilter, excludedBefore: { additions: -1, deletions: 0 } },
    { ...cleanFixture.fileFilter, excludedBefore: { additions: 1.5, deletions: 0 } },
    { ...cleanFixture.fileFilter, excludedBefore: { additions: Number.MAX_SAFE_INTEGER, deletions: 0 } },
    { ...cleanFixture.fileFilter, uninspectedBefore: { additions: 1, deletions: 0, commits: 0 } },
    { ...cleanFixture.fileFilter, uninspectedBefore: { additions: 0, deletions: 0, commits: Number.MAX_SAFE_INTEGER } },
    { ...cleanFixture.fileFilter, uninspectedBefore: { additions: Number.MAX_SAFE_INTEGER, deletions: 0, commits: 1 } },
    { ...cleanFixture.fileFilter, uninspectedAfter: { additions: 0, deletions: 0, commits: 0, repository: 'secret/repository' } },
  ])('rejects malformed, inconsistent, overflowing or identifying filter metadata %#', fileFilter => {
    const value = { ...cleanFixture, fileFilter } as ShareResult;
    expect(decodeShare(raw(value))).toBeNull();
    expect(() => encodeShare(value)).toThrow();
  });

  it('rejects raw-mode inspection counts larger than their counted period and clean after-omissions beyond the snapshot', () => {
    const files = { ...cleanFixture.fileFilter!, enabled: false, inspectedCommits: 298, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 } };
    expect(decodeShare(raw({ ...cleanFixture, fileFilter: { ...files, uninspectedBefore: { additions: 20_001, deletions: 0, commits: 2 } } }))).toBeNull();
    expect(decodeShare(raw({ ...cleanFixture, fileFilter: { ...files, inspectedCommits: 199, uninspectedBefore: { additions: 0, deletions: 0, commits: 101 } } }))).toBeNull();
    expect(decodeShare(raw({ ...cleanFixture, fileFilter: { ...files, inspectedCommits: 200, uninspectedBefore: { additions: 0, deletions: 0, commits: 100 } } }))).toBeNull();
    expect(decodeShare(raw({ ...cleanFixture, cutoff: '2100-01-01', after: { additions: 0, deletions: 0, commits: 0 }, fileFilter: { ...cleanFixture.fileFilter!, inspectedCommits: 100, excludedAfter: { additions: 0, deletions: 0 }, uninspectedAfter: { additions: 1, deletions: 0, commits: 1 } } }))).toBeNull();
  });

  it('discloses file-only incompleteness and lockfile removals without describing raw totals as omitted', async () => {
    const text = createShareText(cleanFixture);
    expect(text).toContain('6/6 repositories complete.');
    expect(text).toContain('Dependency lockfiles/checksums excluded in both periods: before 400 additions / 100 deletions; after 800 additions / 200 deletions.');
    expect(text).toContain('File inspection: 300 complete, 2 incomplete. Partial results: uninspected commits omitted (2 before, 0 after).');
    const image = await recordImage(cleanFixture);
    const context = image.labels.map(label => label.value).join(' ');
    expect(context).toContain('Partial · 6/6 repos complete');
    expect(context).toContain('Lockfiles/checksums excluded');
    expect(context).toContain('Uninspected commits omitted: 2 before / 0 after');
    const rawSnapshot: ShareResult = { ...cleanFixture, fileFilter: { ...cleanFixture.fileFilter!, enabled: false, inspectedCommits: 298, excludedBefore: { additions: 0, deletions: 0 }, excludedAfter: { additions: 0, deletions: 0 } } };
    expect(createShareText(rawSnapshot)).toContain('Uninspected commits retain raw line counts, subject to the size filter.');
    const rawImage = (await recordImage(rawSnapshot)).labels.map(label => label.value).join(' ');
    expect(rawImage).toContain('Lockfiles/checksums included');
    expect(rawImage).not.toMatch(/Partial|omitted/);
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
  it('exports a 2:1 PNG with equally sized bold totals aligned to the website columns', async () => {
    const image = await recordImage(fixture);
    expect([image.width, image.height]).toEqual([1200, 600]);
    expect(image.width / image.height).toBe(2);
    expect(image.blob.type).toBe('image/png');
    const numbers = image.labels.filter(label => label.value === '20,000' || label.value === '60,000');
    expect(numbers).toHaveLength(2);
    expect(numbers[0].size).toBe(108);
    expect(numbers[1].size).toBe(numbers[0].size);
    for (const label of numbers) {
      expect(label.weight).toBe(700);
      expect(label.y).toBe(276);
    }
    expect(numbers[0].color).toBe('#a3a3a3');
    expect(numbers[1].color).toBe('#ededed');
    expect(numbers[0].x).toBe(56);
    expect(numbers[1].x).toBe(640);
    expect(numbers[0].x + numbers[0].width).toBeLessThanOrEqual(560);
    expect(numbers[1].x + numbers[1].width).toBeLessThanOrEqual(1144);
    expect(image.labels.some(label => label.color === '#38bdf8')).toBe(false);
    const unequalDigits = await recordImage({ ...fixture, before: { ...fixture.before, additions: 1_000_000 }, after: { ...fixture.after, additions: 50 } });
    const longNumber = unequalDigits.labels.find(label => label.value === '1,000,000');
    const shortNumber = unequalDigits.labels.find(label => label.value === '50');
    expect(longNumber?.size).toBe(shortNumber?.size);
  });

  it.each([[20_000, 60_000], [60_000, 20_000], [20_000, 20_000]])('partitions one full-width bar for %i before and %i after', async (before, after) => {
    const rendered = await recordImage({ ...fixture, before: { ...fixture.before, additions: before }, after: { ...fixture.after, additions: after } });
    const tracks = rendered.rectangles.filter(rectangle => rectangle.color === '#242424');
    const beforeBar = rendered.rectangles.find(rectangle => rectangle.color === '#a3a3a3');
    const afterBar = rendered.rectangles.find(rectangle => rectangle.color === '#38bdf8');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].width).toBe(1088);
    expect(tracks[0].y).toBe(412);
    expect(beforeBar?.width).toBeCloseTo(before / (before + after) * tracks[0].width);
    expect(afterBar?.width).toBeCloseTo(after / (before + after) * tracks[0].width);
    expect(beforeBar!.width + afterBar!.width).toBe(tracks[0].width);
    expect(beforeBar?.x).toBe(tracks[0].x);
    expect(afterBar?.x).toBe(beforeBar!.x + beforeBar!.width);
    expect(beforeBar?.y).toBe(tracks[0].y);
    expect(afterBar?.y).toBe(tracks[0].y);
    expect(beforeBar?.width! / afterBar?.width!).toBeCloseTo(before / after);
    expect(tracks.every(track => track.height === 6)).toBe(true);
    expect(rendered.labels.map(label => label.value)).not.toContain(describeAdditionChange(before, after));
  });

  it('draws no artificial bar for zero totals and handles a missing baseline', async () => {
    const zero = { ...fixture, before: { additions: 0, deletions: 0, commits: 0 }, after: { additions: 0, deletions: 0, commits: 0 }, firstCommitAt: null };
    const empty = await recordImage(zero);
    expect(empty.rectangles.filter(rectangle => rectangle.color === '#a3a3a3' || rectangle.color === '#38bdf8')).toEqual([]);
    expect(empty.labels.filter(label => label.value === '0')).toHaveLength(2);
    const afterOnly = await recordImage({ ...zero, after: { additions: 50, deletions: 0, commits: 1 }, firstCommitAt: '2025-09-29T12:00:00.000Z' });
    expect(afterOnly.rectangles.some(rectangle => rectangle.color === '#a3a3a3')).toBe(false);
    expect(afterOnly.labels.map(label => label.value)).toContain('50');
    expect(afterOnly.rectangles.find(rectangle => rectangle.color === '#38bdf8')?.width).toBe(1088);
    const beforeOnly = await recordImage({ ...zero, before: { additions: 50, deletions: 0, commits: 1 }, firstCommitAt: '2019-01-01T00:00:00.000Z' });
    expect(beforeOnly.rectangles.some(rectangle => rectangle.color === '#38bdf8')).toBe(false);
    expect(beforeOnly.rectangles.find(rectangle => rectangle.color === '#a3a3a3')?.width).toBe(1088);
  });

  it.each([
    ['dark', '#0a0a0a', '#ededed', '#a3a3a3', '#38bdf8'],
    ['light', '#fafafa', '#171717', '#666', '#0ea5e9'],
  ] as const)('uses a neutral %s palette with blue only on the after segment', async (theme, background, foreground, beforeColor, afterColor) => {
    const image = await recordImage(fixture, theme);
    expect(image.rectangles[0]).toEqual({ x: 0, y: 0, width: 1200, height: 600, color: background });
    expect(image.labels.find(label => label.value === '20,000')?.color).toBe(beforeColor);
    expect(image.labels.find(label => label.value === '60,000')?.color).toBe(foreground);
    expect(image.labels.find(label => label.value === '@octo-dev')).toMatchObject({ x: 56, y: 64, size: 22, weight: 550, color: foreground });
    expect(image.labels.some(label => label.color === afterColor)).toBe(false);
    expect(image.rectangles.find(rectangle => rectangle.color === beforeColor)?.width).toBe(272);
    expect(image.rectangles.find(rectangle => rectangle.color === afterColor)?.width).toBe(816);
  });

  it('aligns each label, total, units and actual dates to one left edge and centers the footer', async () => {
    const image = await recordImage(fixture);
    for (const [labelValue, numberValue, dateValue, left] of [
      ['Before', '20,000', 'Jan 1, 2019 – Sep 28, 2025', 56],
      ['After', '60,000', 'Sep 29, 2025 – Sep 29, 2026', 640],
    ] as const) {
      const label = image.labels.find(item => item.value === labelValue)!;
      const number = image.labels.find(item => item.value === numberValue)!;
      const units = image.labels.find(item => item.value === 'lines added' && item.x === left)!;
      const date = image.labels.find(item => item.value === dateValue)!;
      expect(label).toMatchObject({ x: left, y: 162 });
      expect(number).toMatchObject({ x: left, y: 276 });
      expect(units).toMatchObject({ x: left, y: 324 });
      expect(date).toMatchObject({ x: left, y: 364, size: 20 });
      expect(date.width).toBeLessThanOrEqual(504);
      expect(date.y - date.size).toBeGreaterThan(units.y + units.size * 0.2);
      expect(date.y + date.size * 0.2).toBeLessThan(412);
    }
    const footer = image.labels.find(label => label.value === 'aidiff.cwb.sh · Code with Beto')!;
    expect(footer.x + footer.width / 2).toBe(600);
    expect(footer.y).toBe(552);
    const coverage = image.labels.find(label => label.value.includes('3/6 repos complete'))!;
    expect(coverage.y).toBe(480);
    expect(coverage.x + coverage.width / 2).toBe(600);
  });

  it('keeps units below both totals, actual ranges and separate sample disclosure without old detail clutter', async () => {
    const { labels } = await recordImage({ ...fixture, sample: true });
    const values = labels.map(label => label.value);
    expect(values.filter(value => value === 'lines added')).toHaveLength(2);
    expect(values).not.toContain('Lines added');
    expect(values).toContain('Before');
    expect(values).toContain('After');
    expect(values).toContain('Jan 1, 2019 – Sep 28, 2025');
    expect(values).toContain('Sep 29, 2025 – Sep 29, 2026');
    expect(values.join(' ')).toContain('Partial · 3/6 repos complete');
    expect(values.join(' ')).toContain('Includes private totals');
    expect(values.join(' ')).toContain('Sample data');
    expect(labels.find(label => label.value === '@octo-dev')).toMatchObject({ x: 56, y: 64 });
    expect(labels.find(label => label.value.includes('Sample data'))).toMatchObject({ x: 56, y: 94, size: 16 });
    expect(values).toContain('aidiff.cwb.sh · Code with Beto');
    expect(values.join(' ')).not.toMatch(/SHARED SNAPSHOT|My GitHub|commits · .*deleted|All commit sizes|Illustrative sample|Snapshot as of|Self-reported|authorship|productivity|%/);
    expect(values).toHaveLength(12);
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
    const futureCutoff: ShareResult = { ...large, cutoff: '2100-12-31', after: { additions: 0, deletions: 0, commits: 0 } };
    const fileFiltered: ShareResult = { ...unequal, fileFilter: {
      enabled: true, inspectedCommits: 40_000_000_300, excludedBefore: { additions: 1_000, deletions: 1_000 }, excludedAfter: { additions: 1_000, deletions: 1_000 },
      uninspectedBefore: { additions: 1_000, deletions: 1_000, commits: 4_000_000_000_000_000 }, uninspectedAfter: { additions: 1_000, deletions: 1_000, commits: 4_000_000_000_000_000 },
    } };
    for (const snapshot of [large, filtered, unequal, futureCutoff, fileFiltered]) {
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
