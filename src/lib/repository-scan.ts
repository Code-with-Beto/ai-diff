import type { CommitRecord, FileScanBatch, FileScanPage, Repository, RepositoryProgress, ScanPage, ScanStart } from '../../shared/types';
import { isNonForkRepository } from '../../shared/repository-policy';
import { hasCompleteFiles } from '../../shared/file-policy';
import { ApiError } from '../api';
import { isAuthenticationError } from './client-state';
import { inspectFileBatches } from './file-batches';
import { InspectionCache } from './inspection-cache';
import { ScanScheduler } from './scan-scheduler';

export interface ScanUpdate {
  commits: CommitRecord[];
  progress: RepositoryProgress[];
  reused: number;
  checked: number;
  message: string;
}
export interface RepositoryScanOptions {
  repositories: Repository[];
  userId: string;
  includePrivate: boolean;
  asOf: string;
  signal: AbortSignal;
  cache: InspectionCache;
  request<T>(path: string, body: unknown, signal: AbortSignal): Promise<T>;
  onUpdate(update: ScanUpdate): void;
  /** Exposed for the serial comparison fixture; production always uses four. */
  concurrency?: number;
}
export interface RepositoryScanResult extends ScanUpdate { error?: unknown }

/** Repository work overlaps, while every request shares one bounded scheduler. */
export async function scanRepositories(options: RepositoryScanOptions): Promise<RepositoryScanResult> {
  const { signal: externalSignal, userId, cache } = options;
  const stop = new AbortController();
  const signal = AbortSignal.any([externalSignal, stop.signal]);
  const states: RepositoryProgress[] = options.repositories.map(repository => ({ repository, status: 'pending', commits: 0 }));
  // Keep repository data separate: a revoked/forked repository must never remove
  // a concurrently completed repository, and result order stays deterministic.
  const records: CommitRecord[][] = states.map(() => []);
  const inspected = new Set<string>();
  let reused = 0, next = 0, lastPublish = -Infinity, fatalError: unknown;
  let pauseUntil = 0;
  cache.forAccount(userId);
  function snapshot(): ScanUpdate {
    const active = states.filter(item => item.status === 'scanning').length;
    const message = pauseUntil > Date.now()
      ? `GitHub needs a pause. Continuing after ${new Date(pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You can cancel anytime.`
      : `Checking ${active} ${active === 1 ? 'repository' : 'repositories'} · ${inspected.size.toLocaleString()} commits verified${reused ? ` · ${reused.toLocaleString()} reused` : ''}`;
    return { commits: records.flat(), progress: states.filter(item => isNonForkRepository(item.repository)).map(item => ({ ...item })), reused, checked: inspected.size, message };
  }
  function publish(force = false) {
    if (force || performance.now() - lastPublish >= 250) { lastPublish = performance.now(); options.onUpdate(snapshot()); }
  }
  const scheduler = new ScanScheduler(signal, until => { pauseUntil = until; publish(true); });
  async function transport<T>(path: string, body: unknown): Promise<T> {
    try {
      const value = await options.request<T>(path, body, signal);
      // An expired session stops the shared queue immediately, even if another
      // file-batch sibling is still waiting behind a rate-limit cooldown.
      if (path === '/api/scan/files/batch') {
        const batch = value as FileScanBatch;
        const rejected = batch.results.find(result => 'error' in result && isAuthenticationError(result.error));
        if (rejected && 'error' in rejected) throw new ApiError(rejected.error);
      }
      return value;
    } catch (error) {
      if (!signal.aborted && isAuthenticationError(error)) { fatalError = error; stop.abort(); }
      throw error;
    }
  }
  async function request<T>(path: string, body: unknown): Promise<T> {
    for (let retries = 0;;) {
      signal.throwIfAborted();
      try { return await scheduler.run('history', 1, () => transport<T>(path, body)); }
      catch (error) {
        signal.throwIfAborted();
        if (error instanceof ApiError && error.code === 'rate_limited' && retries < 4) {
          await scheduler.pause(Math.max(error.retryAfter ?? 60, 60 * 2 ** retries++) * 1000, 'rate');
        } else if ((error instanceof TypeError || error instanceof ApiError && ['UNAVAILABLE', 'github_timeout', 'github_unavailable', 'github_fetch_type_error'].includes(error.code)) && retries < 2) {
          await scheduler.pause(1000 * 2 ** retries++, 'retry');
        } else throw error;
      }
    }
  }
  async function scanRepository(index: number): Promise<void> {
    const original = states[index].repository;
    states[index].status = 'scanning'; publish();
    try {
      const start = await request<ScanStart>('/api/scan/start', { repositoryId: original.id, includePrivate: options.includePrivate, asOf: options.asOf, includeFirstPage: true });
      signal.throwIfAborted();
      if (!isNonForkRepository(start.repository)) throw new ApiError({ code: 'forks_excluded', message: 'Forks are excluded.' });
      states[index].repository = start.repository;
      let handle = start.handle, firstPage = start.initialPage;
      const visited = new Set<string>();
      while (handle || firstPage) {
        signal.throwIfAborted();
        if (!firstPage && handle) {
          if (visited.has(handle)) throw new ApiError({ code: 'invalid_scan', message: 'GitHub repeated a history page. Start a new scan.' });
          visited.add(handle);
        }
        const page = firstPage ?? await request<ScanPage>('/api/scan/page', { handle });
        firstPage = undefined;
        signal.throwIfAborted();
        const received = page.commits.map(commit => ({ ...commit, repository: { id: start.repository.id, nameWithOwner: start.repository.nameWithOwner, isPrivate: start.repository.isPrivate } }));
        const offset = records[index].length;
        records[index].push(...received);
        // A received history page remains partial evidence even if its file scan
        // is interrupted. It must not be mislabeled as an unavailable repository.
        states[index].commits += received.length;
        const unchecked: CommitRecord[] = [];
        const positions = new Map<string, number[]>();
        for (let position = 0; position < received.length; position++) {
          const commit = received[position];
          if (commit.parentCount > 1 || commit.authorId !== userId) continue;
          const cached = cache.get(commit);
          if (cached) { records[index][offset + position] = cached; inspected.add(commit.oid); reused++; }
          else {
            const duplicates = positions.get(commit.oid);
            if (duplicates) duplicates.push(offset + position);
            else { positions.set(commit.oid, [offset + position]); unchecked.push(commit); }
          }
        }
        publish();
        await inspectFileBatches(unchecked, {
          batch: handles => scheduler.run('files', handles.length, () => transport<FileScanBatch>('/api/scan/files/batch', { handles })),
          single: fileHandle => scheduler.run('files', 1, () => transport<FileScanPage>('/api/scan/files', { handle: fileHandle })),
          pause: (delay, reason) => scheduler.pause(delay, reason),
        }, signal, (_position, commit) => {
          if (signal.aborted) return;
          if (commit.filesComplete) { inspected.add(commit.oid); cache.put(commit); }
          for (const position of positions.get(commit.oid) ?? []) records[index][position] = { ...records[index][position], files: commit.files, filesComplete: commit.filesComplete, filesError: commit.filesError };
          publish();
        });
        signal.throwIfAborted();
        handle = page.nextHandle;
        publish();
      }
      states[index].status = 'complete'; publish();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError && error.code === 'forks_excluded') {
        records[index] = [];
        states[index] = { ...states[index], repository: { ...original, isFork: true }, status: 'unavailable', commits: 0 };
      } else {
        states[index].status = states[index].commits ? 'incomplete' : 'unavailable';
        states[index].message = error instanceof Error ? error.message : 'Could not finish this repository.';
        if (isAuthenticationError(error) || error instanceof ApiError && ['invalid_scan', 'invalid_file_scan', 'rate_limited', 'invalid_request'].includes(error.code)) {
          fatalError = error; stop.abort();
        }
      }
      publish();
    }
  }
  async function worker() {
    while (!signal.aborted && next < states.length) await scanRepository(next++);
  }
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.min(4, Math.floor(options.concurrency ?? 4))), states.length) }, worker));
  } finally {
    // Rebuild from retained evidence: a later fork rejection may have removed
    // the only verified copy of a SHA seen earlier in a concurrent scan.
    inspected.clear();
    for (const repository of records) for (const commit of repository) {
      if (commit.parentCount <= 1 && commit.authorId === userId && hasCompleteFiles(commit)) inspected.add(commit.oid);
    }
    for (let index = 0; index < states.length; index++) {
      const state = states[index];
      if (state.status === 'pending' || state.status === 'scanning') state.status = 'incomplete';
      if (state.status !== 'complete') continue;
      const unknown = new Set(records[index].filter(commit => commit.parentCount <= 1 && commit.authorId === userId && !inspected.has(commit.oid)).map(commit => commit.oid)).size;
      state.message = unknown ? `${unknown} commits could not finish file checks. They are excluded while lockfile filtering is on.` : undefined;
    }
    publish(true);
  }
  return { ...snapshot(), ...(fatalError ? { error: fatalError } : {}) };
}
