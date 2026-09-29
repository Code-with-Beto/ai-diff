import type { CommitFile, CommitRecord, FileScanBatch, FileScanPage } from '../../shared/types';
import { hasCompleteFiles } from '../../shared/file-policy';
import { ApiError } from '../api';

const fatal = new Set(['session_expired', 'authentication_required', 'unauthenticated', 'invalid_request', 'invalid_scan', 'invalid_file_scan', 'forks_excluded', 'repository_visibility_changed', 'repository_unavailable']);
const transient = new Set(['github_timeout', 'github_unavailable', 'github_request_aborted', 'github_fetch_type_error', 'UNAVAILABLE']);
interface Pending {
  commit: CommitRecord; index: number; handle: string; single: boolean;
  files: CommitFile[]; paths: Set<string>; handles: Set<string>; retries: number;
}
export interface FileBatchReader {
  batch(handles: string[]): Promise<FileScanBatch>;
  single(handle: string): Promise<FileScanPage>;
  pause(milliseconds: number, reason: 'rate' | 'retry'): Promise<void>;
}

/** One browser request at a time; a Worker batch performs four bounded reads. */
export async function inspectFileBatches(
  commits: CommitRecord[], reader: FileBatchReader, signal: AbortSignal,
  onCommit: (index: number, commit: CommitRecord) => void,
): Promise<void> {
  const queue: Pending[] = [];
  const fail = (index: number, commit: CommitRecord, message: string) => onCommit(index, { ...commit, files: undefined, filesComplete: false, filesError: message });
  for (let index = 0; index < commits.length; index++) {
    signal.throwIfAborted();
    const commit = commits[index];
    if (commit.changedFiles === 0 && commit.additions === 0 && commit.deletions === 0) {
      onCommit(index, { ...commit, files: [], filesComplete: true }); continue;
    }
    if (!commit.filesHandle || commit.changedFiles === null || commit.changedFiles === undefined || commit.changedFiles > 3000) {
      fail(index, commit, 'GitHub could not provide a complete file list for this commit.'); continue;
    }
    // Line counts do not predict response size: GitHub often omits long patches.
    // Batch first, and use the actual streamed-byte limit to choose the fallback.
    queue.push({ commit, index, handle: commit.filesHandle, single: false,
      files: [], paths: new Set(), handles: new Set(), retries: 0 });
  }
  while (queue.length) {
    signal.throwIfAborted();
    const group = [queue.shift()!];
    while (!group[0].single && group.length < 4 && queue.length && !queue[0].single) group.push(queue.shift()!);
    let results: FileScanBatch['results'];
    try {
      results = group[0].single
        ? [{ oid: group[0].commit.oid, page: await reader.single(group[0].handle) }]
        : (await reader.batch(group.map(item => item.handle))).results;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiError) || fatal.has(error.code)) throw error;
      results = group.map(item => ({ oid: item.commit.oid, error: { code: error.code, message: error.message, retryAfter: error.retryAfter } }));
    }
    signal.throwIfAborted();
    const byOid = new Map(results.map(result => [result.oid, result]));
    if (results.length !== group.length || byOid.size !== group.length || group.some(item => !byOid.has(item.commit.oid))) {
      throw new Error('GitHub returned mismatched file results. Start this scan again.');
    }
    for (const result of results) if ('error' in result && fatal.has(result.error.code)) throw new ApiError(result.error);
    let pause = 0;
    let pauseReason: 'rate' | 'retry' = 'retry';
    let exhaustedRate: ApiError | undefined;
    for (const state of group) {
      const result = byOid.get(state.commit.oid)!;
      if ('error' in result) {
        if (result.error.code === 'file_batch_retry_single' && !state.single) { state.single = true; queue.push(state); continue; }
        const rateLimited = result.error.code === 'rate_limited';
        if ((rateLimited || transient.has(result.error.code)) && state.retries < (rateLimited ? 4 : 2)) {
          state.retries += 1;
          const delay = rateLimited ? Math.max(result.error.retryAfter ?? 60, 60 * 2 ** (state.retries - 1)) * 1000 : 1000 * 2 ** (state.retries - 1);
          pause = Math.max(pause, delay); if (rateLimited) pauseReason = 'rate';
          queue.push(state); continue;
        }
        if (rateLimited) { exhaustedRate = new ApiError(result.error); continue; }
        fail(state.index, state.commit, result.error.message); continue;
      }
      const page = result.page;
      try {
        if (state.handles.has(state.handle) || state.handles.size >= 30 || page.oid !== state.commit.oid ||
          !Array.isArray(page.files) || page.files.length > 100 || (page.complete && page.nextHandle)) throw new Error('GitHub returned an incomplete file list.');
        state.handles.add(state.handle); state.retries = 0;
        for (const file of page.files) {
          if (!file.filename || state.paths.has(file.filename)) throw new Error('GitHub returned a repeated file page.');
          state.paths.add(file.filename); state.files.push(file);
        }
        if (page.nextHandle) { state.handle = page.nextHandle; queue.push(state); }
        else {
          const inspected = { ...state.commit, files: state.files, filesComplete: page.complete, filesError: undefined };
          if (!hasCompleteFiles(inspected)) throw new Error('File totals did not match the commit. It was left out of filtered results.');
          onCommit(state.index, inspected);
        }
        if (page.remaining <= 10) {
          pause = Math.max(pause, Date.parse(page.resetAt) - Date.now() + 1000); pauseReason = 'rate';
        }
      } catch (error) { fail(state.index, state.commit, error instanceof Error ? error.message : 'Could not verify this commit.'); }
    }
    if (exhaustedRate) throw exhaustedRate;
    if (queue.length && pause > 0) { await reader.pause(pause, pauseReason); signal.throwIfAborted(); }
  }
}
