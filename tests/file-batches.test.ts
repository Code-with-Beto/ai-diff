import { describe, expect, it } from 'vitest';
import { inspectFileBatches, type FileBatchReader } from '../src/lib/file-batches';
import { InspectionCache } from '../src/lib/inspection-cache';
import { ApiError } from '../src/api';
import type { CommitFile, CommitRecord, FileScanBatch, FileScanPage } from '../shared/types';

const file = (filename: string, additions = 1): CommitFile => ({ filename, additions, deletions: 0, status: 'modified' });
const commit = (oid: string, files = [file('app.ts'), file('yarn.lock', 20)]): CommitRecord => ({
  oid, authorId: 'u', parentCount: 1, committedDate: '2025-01-01T00:00:00Z', changedFiles: files.length,
  additions: files.reduce((sum, item) => sum + item.additions, 0), deletions: 0, filesHandle: oid,
});
const page = (oid: string, files = [file('app.ts'), file('yarn.lock', 20)], nextHandle: string | null = null): FileScanPage => ({ oid, files, nextHandle, complete: nextHandle === null, remaining: 4000, resetAt: '2099-01-01T00:00:00Z' });
function reader(overrides: Partial<FileBatchReader> = {}): FileBatchReader {
  return { batch: async handles => ({ results: handles.map(oid => ({ oid, page: page(oid) })) }), single: async oid => page(oid), pause: async () => {}, ...overrides };
}
const signal = () => new AbortController().signal;

describe('bounded file batches', () => {
  it('reduces12commits to3requests and retains exact independently verified file totals', async () => {
    const calls: string[][] = []; const completed: CommitRecord[] = []; let active = 0, peak = 0;
    const transport = reader({ batch: async handles => {
      active++; peak = Math.max(peak, active); calls.push(handles); await Promise.resolve(); active--;
      return { results: handles.map(oid => ({ oid, page: page(oid) })) };
    } });
    await inspectFileBatches(Array.from({ length: 12 }, (_, i) => commit(String(i))), transport, signal(), (_, value) => completed.push(value));
    expect(calls.map(call => call.length)).toEqual([4, 4, 4]); expect(peak).toBe(1);
    expect(completed).toHaveLength(12); expect(completed.every(value => value.filesComplete)).toBe(true);
    expect(completed.reduce((sum, value) => sum + value.files!.reduce((subtotal, item) => subtotal + item.additions, 0), 0)).toBe(252);
  });
  it('keeps successful peers and retries a batch-size overflow through the2MiB single endpoint', async () => {
    const singles: string[] = [], completed: string[] = [];
    await inspectFileBatches([commit('a'), commit('b')], reader({
      batch: async () => ({ results: [{ oid: 'a', page: page('a') }, { oid: 'b', error: { code: 'file_batch_retry_single', message: 'Retry alone' } }] }),
      single: async handle => { singles.push(handle); return page(handle); },
    }), signal(), (_, value) => { expect(value.filesComplete).toBe(true); completed.push(value.oid); });
    expect(singles).toEqual(['b']); expect(completed).toEqual(['a', 'b']);
  });
  it('keeps large line counts in batches when their actual metadata response fits', async () => {
    const files = [file('yarn.lock', 100000), file('app.ts')]; let batchCalls = 0, singleCalls = 0;
    let result: CommitRecord | undefined;
    await inspectFileBatches([commit('large', files)], reader({ batch: async () => { batchCalls++; return { results: [{ oid: 'large', page: page('large', files) }] }; }, single: async oid => { singleCalls++; return page(oid, files); } }), signal(), (_, value) => { result = value; });
    expect(batchCalls).toBe(1); expect(singleCalls).toBe(0); expect(result?.filesComplete).toBe(true);
  });
  it('paginates each SHA without confusing peers or double-counting retries', async () => {
    const calls: string[][] = []; const completed: CommitRecord[] = [];
    const transport = reader({ batch: async handles => { calls.push(handles); return { results: handles.map(handle => {
      const oid = handle.split(':')[0]; return { oid, page: handle.endsWith(':2') ? page(oid, [file('yarn.lock', 20)]) : page(oid, [file('app.ts')], `${oid}:2`) };
    }) }; } });
    await inspectFileBatches([commit('a'), commit('b')], transport, signal(), (_, value) => completed.push(value));
    expect(calls).toEqual([['a', 'b'], ['a:2', 'b:2']]); expect(completed.every(value => value.files?.length === 2 && value.filesComplete)).toBe(true);
  });
  it('shares one cooldown, preserves successes, and retries only rate-limited items', async () => {
    const calls: string[][] = [], pauses: number[] = [], completed: string[] = [];
    await inspectFileBatches([commit('a'), commit('b'), commit('c')], reader({ batch: async handles => {
      calls.push(handles); return { results: handles.map(oid => calls.length === 1 && oid !== 'a'
        ? { oid, error: { code: 'rate_limited', message: 'Pause', retryAfter: oid === 'b' ? 90 : 120 } }
        : { oid, page: page(oid) }) };
    }, pause: async delay => { pauses.push(delay); } }), signal(), (_, value) => completed.push(value.oid));
    expect(calls).toEqual([['a', 'b', 'c'], ['b', 'c']]); expect(pauses).toEqual([120000]); expect(completed).toEqual(['a', 'b', 'c']);
  });
  it('retries temporary upstream errors twice, then explicitly leaves unknown data out', async () => {
    let calls = 0; const pauses: number[] = []; let result: CommitRecord | undefined;
    await inspectFileBatches([commit('a')], reader({ batch: async () => { calls++; throw new ApiError({ code: 'github_timeout', message: 'Timed out' }); }, pause: async delay => { pauses.push(delay); } }), signal(), (_, value) => { result = value; });
    expect(calls).toBe(3); expect(pauses).toEqual([1000, 2000]); expect(result?.filesComplete).toBe(false); expect(result?.files).toBeUndefined();
  });
  it('never loops forever on rate limits', async () => {
    let calls = 0;
    await expect(inspectFileBatches([commit('a')], reader({ batch: async () => { calls++; throw new ApiError({ code: 'rate_limited', message: 'Pause', retryAfter: 1 }); } }), signal(), () => {})).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls).toBe(5);
  });
  it.each(['authentication_required', 'session_expired', 'forks_excluded', 'repository_visibility_changed', 'invalid_file_scan', 'invalid_request'])('stops on%s, at either response level', async code => {
    for (const transport of [reader({ batch: async () => { throw new ApiError({ code, message: 'Fatal' }); } }), reader({ batch: async () => ({ results: [{ oid: 'a', error: { code, message: 'Fatal' } }] }) })]) {
      let completed = false;
      await expect(inspectFileBatches([commit('a')], transport, signal(), () => { completed = true; })).rejects.toMatchObject({ code });
      expect(completed).toBe(false);
    }
  });
  it('drops canceled pending data and never starts another request', async () => {
    const controller = new AbortController(); let calls = 0, completed = 0;
    await expect(inspectFileBatches([commit('a'), commit('b')], reader({ batch: async handles => { calls++; controller.abort(); return { results: handles.map(oid => ({ oid, page: page(oid) })) }; } }), controller.signal, () => { completed++; })).rejects.toThrow();
    expect(calls).toBe(1); expect(completed).toBe(0);
  });
  it('rejects repeated pages, mismatched totals, and unknown changed-file counts', async () => {
    for (const bad of [page('a', [file('app.ts')], 'a'), page('a', [file('app.ts')]), page('a', [file('app.ts'), file('app.ts', 20)])]) {
      let result: CommitRecord | undefined;
      await inspectFileBatches([commit('a')], reader({ batch: async () => ({ results: [{ oid: 'a', page: bad }] }) }), signal(), (_, value) => { result = value; });
      expect(result?.filesComplete).toBe(false);
    }
    let called = false, result: CommitRecord | undefined;
    await inspectFileBatches([{ ...commit('a'), changedFiles: null }], reader({ batch: async () => { called = true; return { results: [] }; } }), signal(), (_, value) => { result = value; });
    expect(called).toBe(false); expect(result?.filesComplete).toBe(false);
  });
  it('rejects missing, duplicate, or foreign batch results', async () => {
    for (const results of [[], [{ oid: 'other', page: page('other') }], [{ oid: 'a', page: page('a') }, { oid: 'a', page: page('a') }]] satisfies FileScanBatch['results'][]) {
      await expect(inspectFileBatches([commit('a')], reader({ batch: async () => ({ results }) }), signal(), () => {})).rejects.toThrow('mismatched');
    }
  });
});

describe('inspection cache', () => {
  const inspected = (oid: string): CommitRecord => ({ ...commit(oid), files: page(oid).files, filesComplete: true, filesHandle: 'old-capability', headline: 'Old title' });
  it('reuses verified files only after fresh matching account/commit metadata and retains fresh attribution', () => {
    const cache = new InspectionCache(); cache.forAccount('u'); cache.put(inspected('a'));
    const fresh = { ...commit('a'), filesHandle: 'fresh-capability', headline: 'Fresh title', repository: { id: 'new', nameWithOwner: 'u/new', isPrivate: true } };
    expect(cache.get(fresh)).toMatchObject({ ...fresh, filesComplete: true, files: page('a').files });
    for (const change of [{ additions: 22 }, { deletions: 1 }, { authorId: 'other' }, { committedDate: '2026-01-01T00:00:00Z' }, { parentCount: 2 }, { changedFiles: 3 }]) expect(cache.get({ ...fresh, ...change })).toBeUndefined();
  });
  it('never caches partial data and drops everything on logout or account switch', () => {
    const cache = new InspectionCache(); cache.forAccount('u'); cache.put({ ...inspected('a'), filesComplete: false }); expect(cache.get(commit('a'))).toBeUndefined();
    cache.put(inspected('a')); cache.forAccount('other'); cache.forAccount('u'); expect(cache.get(commit('a'))).toBeUndefined();
    cache.put(inspected('a')); cache.clear(); cache.forAccount('u'); expect(cache.get(commit('a'))).toBeUndefined();
  });
  it('enforces a bounded LRU budget', () => {
    const cache = new InspectionCache(1900); cache.forAccount('u'); cache.put(inspected('a')); cache.put(inspected('b'));
    expect(cache.get(commit('a'))).toBeTruthy(); cache.put(inspected('c'));
    expect(cache.get(commit('b'))).toBeUndefined(); expect(cache.get(commit('a'))).toBeTruthy(); expect(cache.get(commit('c'))).toBeTruthy();
  });
});
