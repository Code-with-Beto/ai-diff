import { describe, expect, it } from 'vitest';
import { analyzeCommits } from '../src/lib/analysis';
import { hasCompleteFiles, isLockfile } from '../shared/file-policy';
import { inspectCommitFiles } from '../src/lib/file-scan';
import type { CommitFile, CommitRecord, FileScanPage } from '../shared/types';
const repo = { id: 'r', nameWithOwner: 'dev/project', isPrivate: false, isFork: false, isArchived: false, description: null };
const progress = [{ repository: repo, status: 'complete' as const, commits: 1 }];
const file = (filename: string, additions: number, deletions = 0): CommitFile => ({ filename, additions, deletions, status: 'modified' });
function commit(oid: string, files: CommitFile[], date = '2025-09-01T00:00:00.000Z'): CommitRecord {
  return { oid, committedDate: date, additions: files.reduce((s,f) => s+f.additions,0), deletions: files.reduce((s,f) => s+f.deletions,0),
    authorId: 'dev', parentCount: 1, files, filesComplete: true, changedFiles: files.length, filesHandle: `start-${oid}` };
}
const analyze = (commits: CommitRecord[], enabled = true) => analyzeCommits(commits, 'dev', '2025-09-29', '2026-01-01T00:00:00.000Z', progress, { excludeLockfiles: enabled });
describe('file filtering', () => {
  it('matches exact dependency basenames at any depth while retaining manifests and arbitrary lock-named files', () => {
    for (const name of ['package-lock.json', 'example/yarn.lock', 'ios/Podfile.lock', 'nested/go.sum', 'uv.lock', 'Package.resolved']) expect(isLockfile(name)).toBe(true);
    for (const name of ['package.json', 'requirements.txt', 'src/lock.ts', 'src/file.lock', 'not-package-lock.json']) expect(isLockfile(name)).toBe(false);
  });
  it('removes additions and deletions symmetrically and toggles back to raw without mutating commits', () => {
    const before = commit('before', [file('src/app.ts', 36, 2), file('package-lock.json', 21652), file('yarn.lock', 6253, 6141)]);
    const after = commit('after', before.files!, '2025-09-29T00:00:00.000Z');
    const clean = analyze([before, after]);
    expect(clean.before).toEqual({ additions: 36, deletions: 2, commits: 1 }); expect(clean.after).toEqual(clean.before);
    expect(clean.fileFilter).toMatchObject({ inspectedCommits: 2, excludedBefore: { additions: 27905, deletions: 6141 }, excludedAfter: { additions: 27905, deletions: 6141 } });
    expect(analyze([before,after], false).before.additions).toBe(27941);
    expect(before.additions).toBe(27941);
  });
  it('applies the oversized heuristic after removing locks, preserving useful code in a large import', () => {
    const result = analyze([commit('import', [file('yarn.lock', 200000), file('app.ts', 100)])]);
    expect(result.before.additions).toBe(100); expect(result.commitFilter?.excludedBefore.commits).toBe(0);
    expect(analyze([commit('real-large', [file('app.ts', 100001)])]).before.commits).toBe(0);
  });
  it('does not subtract source deletions on a rename into a lockfile, or count old lockfile deletions on a rename out', () => {
    const c = commit('rename', [{ ...file('yarn.lock', 30, 20), previousFilename: 'notes.txt', status: 'renamed' }, { ...file('data.txt', 5, 4), previousFilename: 'package-lock.json', status: 'renamed' }]);
    expect(analyze([c]).before).toEqual({ additions: 5, deletions: 20, commits: 1 });
  });
  it('deduplicates inspected pages, excludes merges/other authors and keeps zero-line lock-only commits explainable', () => {
    const c=commit('lock', [file('yarn.lock', 100)]);
    const result=analyze([c,c,{...c,oid:'merge',parentCount:2},{...c,oid:'other',authorId:'other'}]);
    expect(result.before).toEqual({additions:0,deletions:0,commits:1});
    expect(result.details).toHaveLength(1); expect(result.fileFilter?.excludedBefore.additions).toBe(100);
    expect(result.months[0]).toEqual({month:'2025-09',before:0,after:0});
  });
  it('uses a successful retry of a SHA without double-counting an earlier incomplete copy', () => {
    const c=commit('retry',[file('app.ts',10),file('yarn.lock',100)]);
    const result=analyze([{...c, files: undefined, filesComplete:false},c]);
    expect(result.before.additions).toBe(10);expect(result.before.commits).toBe(1);
    expect(result.fileFilter?.uninspectedBefore.commits).toBe(0);
  });
  it('never substitutes raw counts for missing, truncated, repeated or mismatched file data', () => {
    const c=commit('c',[file('app.ts',10),file('yarn.lock',100)]);
    const variants=[{...c,filesComplete:false},{...c,files:undefined},{...c,changedFiles:null},{...c,changedFiles:undefined},{...c,changedFiles:-1},{...c,changedFiles:1.5},{...c,files:[c.files![0]]},{...c,files:[c.files![0],c.files![0]]}];
    for(const partial of variants){
      expect(hasCompleteFiles(partial)).toBe(false);
      const result=analyze([partial]); expect(result.before.commits).toBe(0);expect(result.firstCommitAt).toBeNull();
      expect(result.fileFilter?.uninspectedBefore).toEqual({additions:110,deletions:0,commits:1});
      expect(result.details?.[0].exclusion).toBe('files_unavailable');
      expect(analyze([partial],false).before.additions).toBe(110);
    }
  });
});

describe('client file pagination', () => {
  const first=file('app.ts',10), second=file('yarn.lock',100);
  const base=commit('c',[first,second]);
  const page=(files:CommitFile[],nextHandle:string|null,complete:boolean):FileScanPage=>({oid:'c',files,nextHandle,complete,remaining:100,resetAt:'2026-01-01T00:00:00Z'});
  it('returns only fully reconciled file lists across pages',async()=>{
    const pages=[page([first],'next',false),page([second],null,true)];const handles:string[]=[];
    const result=await inspectCommitFiles(base,async handle=>{handles.push(handle);return pages.shift()!;},new AbortController().signal);
    expect(handles).toEqual(['start-c','next']);expect(result.files).toEqual([first,second]);expect(result.filesComplete).toBe(true);
  });
  it('rejects repeated cursors, duplicate files, mismatches and incomplete terminal pages',async()=>{
    for(const pages of [[page([first],'start-c',false)], [page([first],'next',false),page([first],null,true)], [page([first],null,true)], [page([first,second],null,false)], [{...page([first,second],null,true),oid:'wrong'}]]){
      await expect(inspectCommitFiles(base,async()=>pages.shift()!,new AbortController().signal)).rejects.toThrow();
    }
  });
  it('stops after cancellation without accepting pending page data',async()=>{
    const controller=new AbortController();
    await expect(inspectCommitFiles(base,async()=>{controller.abort();return page([first,second],null,true);},controller.signal)).rejects.toThrow();
  });
});
