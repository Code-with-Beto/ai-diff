import { expect, it } from 'vitest';
import { analyzeCommits } from '../src/lib/analysis';
import type { CommitFile, CommitRecord, RepositoryProgress } from '../shared/types';

const userId = 'analysis-performance-user';
const asOf = '2026-09-29T12:00:00.000Z';
const progress: RepositoryProgress[] = [{ repository: { id: 'analysis-repo', nameWithOwner: 'fixture/project', isPrivate: false,
  isFork: false, isArchived: false, description: null }, status: 'complete', commits: 2000 }];

function fixture(count = 2000, onFileRead?: () => void): CommitRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const files: CommitFile[] = Array.from({ length: 50 }, (_, fileIndex) => {
      const filename = fileIndex === 0 ? 'package-lock.json' : `src/component-${fileIndex}.tsx`;
      return Object.freeze({ get filename() { onFileRead?.(); return filename; }, status: 'modified',
        additions: fileIndex === 0 ? 1000 : 10, deletions: fileIndex === 0 ? 100 : 1 });
    });
    return Object.freeze({ oid: index.toString(16).padStart(40, '0'), authorId: userId, parentCount: 1, additions: 1490, deletions: 149,
      committedDate: index % 2 ? '2025-12-01T00:00:00.000Z' : '2025-01-01T00:00:00.000Z',
      files, filesComplete: true, changedFiles: files.length });
  });
}

it('reuses validated file summaries across progress, cutoff, and filter changes without rereading file lists', () => {
  let fileReads = 0;
  const commits = fixture(2000, () => { fileReads += 1; });
  const first = analyzeCommits(commits, userId, '2025-11-24', asOf, progress, { excludeLockfiles: true });
  expect(first.before.additions + first.after.additions).toBe(980000);
  expect(first.fileFilter?.inspectedCommits).toBe(2000);
  expect(fileReads).toBeGreaterThan(0);
  fileReads = 0;
  const raw = analyzeCommits(commits, userId, '2025-01-01', asOf, [{ ...progress[0], status: 'incomplete' }], { excludeLockfiles: false });
  expect(raw.before.additions).toBe(0);
  expect(raw.after.additions).toBe(2980000);
  expect(raw.coverage.incomplete).toBe(1);
  const cleanAgain = analyzeCommits(commits, userId, '2025-11-24', asOf, progress, { excludeLockfiles: true });
  expect(cleanAgain).toEqual(first);
  expect(fileReads).toBe(0);
});

it('does not reuse an incomplete or mismatched summary for a replacement record or a successful duplicate', () => {
  const complete = fixture(1)[0];
  const unknown = { ...complete, filesComplete: false };
  const mismatched = { ...complete, additions: complete.additions + 1 };
  const analyze = (commits: CommitRecord[]) => analyzeCommits(commits, userId, '2025-11-24', asOf, progress, { excludeLockfiles: true });
  expect(analyze([unknown]).before.commits).toBe(0);
  expect(analyze([mismatched]).before.commits).toBe(0);
  expect(analyze([unknown, complete]).before).toEqual({ additions: 490, deletions: 49, commits: 1 });
  expect(analyze([mismatched, complete]).before.commits).toBe(0);
  expect(analyze([complete]).before.additions).toBe(490);
});

it.skipIf(process.env.ANALYSIS_BENCHMARK !== '1')('reports repeated analysis timing for 2000 commits and 100000 files', () => {
  const commits = fixture();
  const run = () => analyzeCommits(commits, userId, '2025-11-24', asOf, progress, { excludeLockfiles: true });
  const started = performance.now();
  const first = run();
  const coldMs = performance.now() - started;
  expect(first.before.additions + first.after.additions).toBe(980000);
  for (let index = 0; index < 10; index += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now(); run(); samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(`${JSON.stringify({ benchmark: 'browser-analysis-local-wall-time', commits: commits.length, files: 100000,
    coldMs: Number(coldMs.toFixed(3)), medianMs: Number(((samples[49] + samples[50]) / 2).toFixed(3)), p95Ms: Number(samples[94].toFixed(3)),
    note: 'Local Node wall time; file validation is cached after the first pass. No timing threshold is asserted.' })}\n`);
});
