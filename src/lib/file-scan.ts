import type { CommitFile, CommitRecord, FileScanPage } from '../../shared/types';
import { hasCompleteFiles } from '../../shared/file-policy';

export async function inspectCommitFiles(
  commit: CommitRecord,
  readPage: (handle: string) => Promise<FileScanPage>,
  signal: AbortSignal,
): Promise<CommitRecord> {
  signal.throwIfAborted();
  if (commit.changedFiles === 0 && commit.additions === 0 && commit.deletions === 0) return { ...commit, files: [], filesComplete: true };
  if (!commit.filesHandle) throw new Error('GitHub could not provide a complete file list for this commit.');
  let handle: string | null = commit.filesHandle;
  const handles = new Set<string>();
  const paths = new Set<string>();
  const files: CommitFile[] = [];
  while (handle) {
    signal.throwIfAborted();
    if (handles.has(handle) || handles.size >= 30) throw new Error('The file list could not be fully paginated.');
    handles.add(handle);
    const page = await readPage(handle);
    signal.throwIfAborted();
    if (page.oid !== commit.oid || !Array.isArray(page.files) || page.files.length > 100 || (page.complete && page.nextHandle)) throw new Error('GitHub returned an incomplete file list.');
    for (const file of page.files) {
      if (!file.filename || paths.has(file.filename)) throw new Error('GitHub returned a repeated file page.');
      paths.add(file.filename); files.push(file);
    }
    handle = page.nextHandle;
    if (!handle) {
      const inspected = { ...commit, files, filesComplete: page.complete };
      if (!hasCompleteFiles(inspected)) throw new Error('File totals did not match the commit. It was left out of filtered results.');
      return inspected;
    }
  }
  throw new Error('The file list could not be completed.');
}
