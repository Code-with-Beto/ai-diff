import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitFile, CommitRecord, FileScanBatch, FileScanPage, Repository, ScanPage, ScanStart } from '../shared/types';
import { ApiError } from '../src/api';
import { analyzeCommits } from '../src/lib/analysis';
import { InspectionCache } from '../src/lib/inspection-cache';
import { scanRepositories, type RepositoryScanOptions, type RepositoryScanResult, type ScanUpdate } from '../src/lib/repository-scan';

const userId = 'fixture-user';
const asOf = '2026-09-29T12:00:00.000Z';
const cutoff = '2025-11-24';
const file = (filename: string, additions = 10, deletions = 2): CommitFile => ({ filename, additions, deletions, status: 'modified' });
const defaultFiles = () => [file('src/app.ts'), file('package-lock.json', 100, 20)];
const oid = (value: number) => value.toString(16).padStart(40, '0');
const repository = (index: number): Repository => ({ id: `repo-${index}`, nameWithOwner: `fixture/project-${index}`, isPrivate: false, isFork: false, isArchived: false, description: null });

interface Fixture {
  repository: Repository;
  pages: CommitRecord[][];
  files: Map<string, CommitFile[]>;
}
function fixture(index: number, count = 2): Fixture {
  const files = new Map<string, CommitFile[]>();
  const commits = Array.from({ length: count }, (_, position): CommitRecord => {
    const sha = oid(index * 1000 + position + 1);
    const changed = defaultFiles(); files.set(sha, changed);
    return { oid: sha, authorId: userId, parentCount: 1, changedFiles: changed.length,
      additions: changed.reduce((sum, item) => sum + item.additions, 0), deletions: changed.reduce((sum, item) => sum + item.deletions, 0),
      committedDate: position % 2 ? '2025-12-01T00:00:00.000Z' : '2025-01-01T00:00:00.000Z' };
  });
  return { repository: repository(index), pages: count ? [commits] : [], files };
}

interface RequestCall { path: string; body: Record<string, unknown>; at: number; repositoryId: string; signal: AbortSignal }
interface TransportOptions {
  latency?: (call: RequestCall) => number;
  override?: (call: RequestCall) => unknown;
  ignoreAbort?: boolean;
}
function transport(fixtures: Fixture[], options: TransportOptions = {}) {
  const calls: RequestCall[] = [];
  let active = 0, peak = 0;
  const byId = new Map(fixtures.map(item => [item.repository.id, item]));
  const history = (item: Fixture, position: number): ScanPage => ({
    commits: item.pages[position].map(commit => ({ ...commit, filesHandle: `files/${item.repository.id}/${commit.oid}/0` })),
    nextHandle: position + 1 < item.pages.length ? `history/${item.repository.id}/${position + 1}` : null,
    remaining: 5000, resetAt: '2099-01-01T00:00:00.000Z',
  });
  const files = (handle: string): FileScanPage => {
    const [, id, sha, pageString] = handle.split('/');
    const allFiles = byId.get(id)!.files.get(sha)!;
    const page = Number(pageString);
    const hasMore = (page + 1) * 100 < allFiles.length;
    return { oid: sha, files: allFiles.slice(page * 100, (page + 1) * 100), complete: !hasMore,
      nextHandle: hasMore ? `files/${id}/${sha}/${page + 1}` : null, remaining: 5000, resetAt: '2099-01-01T00:00:00.000Z' };
  };
  async function request<T>(path: string, rawBody: unknown, signal: AbortSignal): Promise<T> {
    const body = rawBody as Record<string, unknown>;
    const handle = typeof body.handle === 'string' ? body.handle : (body.handles as string[] | undefined)?.[0];
    const repositoryId = typeof body.repositoryId === 'string' ? body.repositoryId : handle!.split('/')[1];
    const call: RequestCall = { path, body, at: Date.now(), repositoryId, signal };
    calls.push(call); active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted && !options.ignoreAbort) { reject(signal.reason); return; }
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, options.latency?.(call) ?? (path.includes('/files') ? 40 : 20));
        if (!options.ignoreAbort) signal.addEventListener('abort', cancel, { once: true });
      });
      const override = options.override?.(call);
      if (override !== undefined) return override as T;
      const item = byId.get(repositoryId)!;
      if (path === '/api/scan/start') {
        expect(body).toMatchObject({ includeFirstPage: true, asOf, includePrivate: false });
        const initialPage = item.pages.length ? history(item, 0) : undefined;
        return { repository: item.repository, empty: !initialPage, handle: initialPage?.nextHandle ?? null, ...(initialPage ? { initialPage } : {}) } satisfies ScanStart as T;
      }
      if (path === '/api/scan/page') return history(item, Number((body.handle as string).split('/')[2])) as T;
      if (path === '/api/scan/files') return files(body.handle as string) as T;
      if (path === '/api/scan/files/batch') return { results: (body.handles as string[]).map(handle => ({ oid: handle.split('/')[2], page: files(handle) })) } satisfies FileScanBatch as T;
      throw new Error(`Unexpected fixture endpoint: ${path}`);
    } finally { active--; }
  }
  return { request, calls, get peak() { return peak; }, get active() { return active; } };
}
async function run(fixtures: Fixture[], network = transport(fixtures), overrides: Partial<RepositoryScanOptions> = {}) {
  const updates: ScanUpdate[] = [];
  const started = Date.now();
  const pending = scanRepositories({ repositories: fixtures.map(item => item.repository), userId, includePrivate: false, asOf,
    signal: new AbortController().signal, cache: new InspectionCache(), request: network.request, onUpdate: update => updates.push(update), ...overrides });
  await vi.runAllTimersAsync();
  return { result: await pending, elapsed: Date.now() - started, updates, network };
}
const analyze = (result: RepositoryScanResult) => analyzeCommits(result.commits, userId, cutoff, asOf, result.progress, { enabled: false, excludeLockfiles: true });
const fileCalls = (network: ReturnType<typeof transport>) => network.calls.filter(call => call.path.includes('/files'));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(asOf)); });
afterEach(() => { vi.useRealTimers(); });

describe('repository scan coordination', () => {
  it('overlaps four repositories while sharing a global four-request bound across history and files', async () => {
    const fixtures = Array.from({ length: 8 }, (_, index) => fixture(index, 6));
    const { result, network, updates } = await run(fixtures);
    expect(network.peak).toBe(4);
    expect(network.active).toBe(0);
    expect(Math.max(...updates.map(update => update.progress.filter(item => item.status === 'scanning').length))).toBe(4);
    expect(network.calls.slice(0, 4).map(call => call.repositoryId)).toEqual(fixtures.slice(0, 4).map(item => item.repository.id));
    expect(result.progress.every(item => item.status === 'complete')).toBe(true);
    expect(result.checked).toBe(48);
    expect(analyze(result).before).toEqual({ additions: 240, deletions: 48, commits: 24 });
  });

  it('finishes the 180-repository simulated workload sooner than serial scanning with identical exact totals', async () => {
    const fixtures = Array.from({ length: 180 }, (_, index) => fixture(index, 10));
    const networkOptions = { latency: (call: RequestCall) => call.path.includes('/files') ? 400 : 200 };
    const serial = await run(fixtures, transport(fixtures, networkOptions), { concurrency: 1 });
    const parallel = await run(fixtures, transport(fixtures, networkOptions));
    expect(analyze(parallel.result)).toEqual(analyze(serial.result));
    expect(analyze(parallel.result).before).toEqual({ additions: 9000, deletions: 1800, commits: 900 });
    expect(analyze(parallel.result).after).toEqual({ additions: 9000, deletions: 1800, commits: 900 });
    expect(parallel.result.progress).toHaveLength(180);
    expect(parallel.result.progress.every(item => item.status === 'complete')).toBe(true);
    expect(parallel.result.checked).toBe(1800);
    expect(parallel.network.peak).toBe(4);
    expect(serial.network.peak).toBeLessThanOrEqual(2);
    expect(parallel.elapsed).toBeLessThan(serial.elapsed);
    if (process.env.SCAN_BENCHMARK === '1') process.stdout.write(`${JSON.stringify({ benchmark: 'simulated-repository-scan', repositories: 180, commits: 1800,
      assumedHistoryLatencyMs: 200, assumedFileBatchLatencyMs: 400, serialMs: serial.elapsed, parallelMs: parallel.elapsed,
      peakRequests: parallel.network.peak, exactTotalsMatch: true,
      note: 'Fake network delays with the real client scheduler. This is not a live GitHub or Cloudflare speed measurement.' })}\n`);
  }, 20000);

  it('completes an empty repository with no file requests and zero totals', async () => {
    const { result, network } = await run([fixture(0, 0)]);
    expect(network.calls.map(call => call.path)).toEqual(['/api/scan/start']);
    expect(result.progress[0]).toMatchObject({ status: 'complete', commits: 0 });
    expect(result.commits).toEqual([]);
    expect(analyze(result).coverage).toEqual({ completed: 1, unavailable: 0, incomplete: 0, total: 1 });
    expect(analyze(result).ratio).toBeNull();
  });

  it('deduplicates identical SHAs across repositories and never inspects merge or other-author commits', async () => {
    const first = fixture(0, 3), second = fixture(1, 1);
    first.pages[0][1].parentCount = 2;
    first.pages[0][2].authorId = 'someone-else';
    second.pages[0] = [{ ...first.pages[0][0] }];
    second.files = new Map([[first.pages[0][0].oid, first.files.get(first.pages[0][0].oid)!]]);
    const { result, network } = await run([first, second]);
    expect(result.commits).toHaveLength(4);
    expect(result.checked).toBe(1);
    expect(analyze(result).before).toEqual({ additions: 10, deletions: 2, commits: 1 });
    expect(fileCalls(network).flatMap(call => call.body.handles as string[]).every(handle => handle.includes(first.pages[0][0].oid))).toBe(true);
  });

  it('follows multiple history pages and a commit with more than 100 files without losing or double-counting a page', async () => {
    const item = fixture(0, 3);
    const all = item.pages[0];
    item.pages = [[all[0]], [all[1]], [all[2]]];
    const manyFiles = Array.from({ length: 103 }, (_, index) => file(index === 102 ? 'yarn.lock' : `src/file-${index}.ts`, 1, 0));
    item.files.set(all[1].oid, manyFiles);
    Object.assign(all[1], { changedFiles: 103, additions: 103, deletions: 0 });
    const { result, network } = await run([item]);
    expect(network.calls.filter(call => call.path === '/api/scan/page').map(call => call.body.handle)).toEqual(['history/repo-0/1', 'history/repo-0/2']);
    expect(fileCalls(network).flatMap(call => call.body.handles as string[])).toContain(`files/repo-0/${all[1].oid}/1`);
    expect(result.commits.map(commit => commit.files?.length)).toEqual([2, 103, 2]);
    expect(result.progress[0]).toMatchObject({ status: 'complete', commits: 3 });
    expect(analyze(result).before).toEqual({ additions: 20, deletions: 4, commits: 2 });
    expect(analyze(result).after).toEqual({ additions: 102, deletions: 0, commits: 1 });
  });

  it('rolls back only a repository later identified as a fork, retaining completed parallel data and duplicate SHAs', async () => {
    const fork = fixture(0, 3), good = fixture(1, 1);
    const [shared, own, last] = fork.pages[0];
    fork.pages = [[shared, own], [last]];
    good.pages = [[{ ...shared }]]; good.files = new Map([[shared.oid, fork.files.get(shared.oid)!]]);
    const network = transport([fork, good], { override: call => {
      if (call.repositoryId === fork.repository.id && call.path === '/api/scan/page') throw new ApiError({ code: 'forks_excluded', message: 'Forks are excluded.' });
    } });
    const { result } = await run([fork, good], network);
    expect(result.error).toBeUndefined();
    expect(result.progress.map(item => item.repository.id)).toEqual([good.repository.id]);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].repository?.id).toBe(good.repository.id);
    expect(analyze(result).before).toEqual({ additions: 10, deletions: 2, commits: 1 });
  });

  it('does not report file verification from a discarded fork as coverage for an unsuccessful retained duplicate', async () => {
    const fork = fixture(0, 2), good = fixture(1, 1);
    const [shared, last] = fork.pages[0]; fork.pages = [[shared], [last]];
    good.pages = [[{ ...shared }]]; good.files = new Map([[shared.oid, fork.files.get(shared.oid)!]]);
    const network = transport([fork, good], { override: call => {
      if (call.repositoryId === fork.repository.id && call.path === '/api/scan/page') throw new ApiError({ code: 'forks_excluded', message: 'Forks are excluded.' });
      if (call.repositoryId === good.repository.id && call.path.includes('/files')) return { results: [{ oid: shared.oid, error: { code: 'file_unavailable', message: 'File details are unavailable.' } }] } satisfies FileScanBatch;
    } });
    const { result } = await run([fork, good], network);
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].filesComplete).toBe(false);
    expect(result.progress).toHaveLength(1);
    expect(result.progress[0]).toMatchObject({ status: 'complete', message: expect.stringContaining('1 commits could not finish file checks') });
    expect(result.checked).toBe(0);
    expect(analyze(result).before.commits).toBe(0);
    expect(analyze(result).fileFilter?.uninspectedBefore.commits).toBe(1);
  });

  it.each(['session_expired', 'authentication_required'])('stops active and pending repositories after %s', async code => {
    const fixtures = Array.from({ length: 9 }, (_, index) => fixture(index));
    const network = transport(fixtures, { latency: call => call.repositoryId === fixtures[0].repository.id ? 10 : 100,
      override: call => { if (call.repositoryId === fixtures[0].repository.id) throw new ApiError({ code, message: 'Connect GitHub again.' }); } });
    const { result } = await run(fixtures, network);
    expect(result.error).toMatchObject({ code });
    expect(network.calls).toHaveLength(4);
    expect(network.calls.every(call => call.signal.aborted)).toBe(true);
    expect(result.commits).toEqual([]);
    // Expired account authorization interrupts the whole scan; it does not
    // establish that any individual repository is unavailable.
    expect(result.progress.map(item => item.status)).toEqual(Array(9).fill('incomplete'));
    expect(network.active).toBe(0);
  });

  it('immediately aborts sibling and queued requests when one file batch returns an authentication error', async () => {
    const fixtures = Array.from({ length: 8 }, (_, index) => fixture(index, 4));
    const failingHandle = `files/repo-0/${fixtures[0].pages[0][0].oid}/0`;
    const isAuthFailure = (call: RequestCall) => (call.body.handles as string[] | undefined)?.[0] === failingHandle;
    const network = transport(fixtures, {
      latency: call => call.path === '/api/scan/start' ? 20 : isAuthFailure(call) ? 10 : 1000,
      override: call => isAuthFailure(call) ? { results: (call.body.handles as string[]).map(handle => ({ oid: handle.split('/')[2], error: { code: 'session_expired', message: 'Connect GitHub again.' } })) } satisfies FileScanBatch : undefined,
    });
    const { result, elapsed } = await run(fixtures, network);
    expect(result.error).toMatchObject({ code: 'session_expired' });
    expect(elapsed).toBeLessThan(1000);
    expect(network.active).toBe(0);
    expect(network.calls.every(call => call.signal.aborted)).toBe(true);
    expect(network.calls.filter(call => call.path === '/api/scan/start')).toHaveLength(4);
    expect(result.progress.every(item => item.status === 'incomplete')).toBe(true);
    expect(result.commits.every(commit => !commit.filesComplete)).toBe(true);
  });

  it('preserves successful repositories and checked partial pages when unrelated repositories fail', async () => {
    const complete = fixture(0, 2), partial = fixture(1, 2), unavailable = fixture(2, 1), filesFailed = fixture(3, 1);
    partial.pages = partial.pages[0].map(commit => [commit]);
    const fixtures = [complete, partial, unavailable, filesFailed];
    const network = transport(fixtures, { override: call => {
      if (call.repositoryId === partial.repository.id && call.path === '/api/scan/page') throw new ApiError({ code: 'repository_unavailable', message: 'History is unavailable.' });
      if (call.repositoryId === unavailable.repository.id && call.path === '/api/scan/start') throw new ApiError({ code: 'repository_unavailable', message: 'Repository is unavailable.' });
      if (call.repositoryId === filesFailed.repository.id && call.path.includes('/files')) throw new ApiError({ code: 'repository_unavailable', message: 'Access was removed.' });
    } });
    const { result } = await run(fixtures, network);
    expect(result.error).toBeUndefined();
    expect(result.progress.map(item => item.status)).toEqual(['complete', 'incomplete', 'unavailable', 'incomplete']);
    expect(analyze(result).coverage).toEqual({ completed: 1, unavailable: 1, incomplete: 2, total: 4 });
    expect(analyze(result).before).toEqual({ additions: 20, deletions: 4, commits: 2 });
    expect(analyze(result).after).toEqual({ additions: 10, deletions: 2, commits: 1 });
    expect(analyze(result).fileFilter?.uninspectedBefore.commits).toBe(1);
  });

  it('discards file responses arriving after cancellation and leaves the partial history explicitly unverified', async () => {
    const item = fixture(0, 2); item.pages = item.pages[0].map(commit => [commit]);
    const network = transport([item], { ignoreAbort: true, latency: call => call.path.includes('/files') ? 100 : 10 });
    const controller = new AbortController(), updates: ScanUpdate[] = [];
    const pending = scanRepositories({ repositories: [item.repository], userId, includePrivate: false, asOf, signal: controller.signal,
      cache: new InspectionCache(), request: network.request, onUpdate: update => updates.push(update) });
    await vi.advanceTimersByTimeAsync(20);
    expect(fileCalls(network)).toHaveLength(1);
    controller.abort();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(network.calls).toHaveLength(2);
    expect(result.checked).toBe(0);
    expect(result.progress[0]).toMatchObject({ status: 'incomplete', commits: 1 });
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].filesComplete).not.toBe(true);
    expect(updates.every(update => update.commits.every(commit => !commit.filesComplete))).toBe(true);
    expect(analyze(result).before.commits).toBe(0);
    expect(analyze(result).fileFilter?.uninspectedBefore.commits).toBe(1);
  });

  it('reuses verified files only within an account while still rereading authorized history on every scan', async () => {
    const item = fixture(0, 3), cache = new InspectionCache();
    const first = await run([item], transport([item]), { cache });
    const second = await run([item], transport([item]), { cache });
    expect(analyze(second.result)).toEqual(analyze(first.result));
    expect(second.result.reused).toBe(3);
    expect(second.result.checked).toBe(3);
    expect(second.network.calls.map(call => call.path)).toEqual(['/api/scan/start']);
    const other = await run([item], transport([item]), { cache, userId: 'different-account' });
    expect(other.result.reused).toBe(0);
    expect(other.result.checked).toBe(0);
    expect(fileCalls(other.network)).toHaveLength(0);
    const returned = await run([item], transport([item]), { cache });
    expect(returned.result.reused).toBe(0);
    expect(fileCalls(returned.network).length).toBeGreaterThan(0);
    expect(analyze(returned.result)).toEqual(analyze(first.result));
  });
});
