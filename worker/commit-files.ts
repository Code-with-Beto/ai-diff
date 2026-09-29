import type { CommitFile, CommitRecord, FileScanBatch, FileScanPage } from '../shared/types';
import { ApiError, FILE_REPOSITORY_QUERY, github } from './github';
import { createSigner, createVerifier, sign, verify, type CryptoEnvironment } from './security';

export const FILE_RESPONSE_LIMIT = 2 * 1024 * 1024;
export const FILE_BATCH_RESPONSE_LIMIT = 384 * 1024;
export const FILE_BATCH_BODY_LIMIT = 32 * 1024;
// Continue accepting the original envelope while limiting active work per
// invocation to fit Workers Free's CPU budget on measured production traffic.
export const FILE_BATCH_SIZE = 4;
export const FILE_BATCH_CONCURRENCY = 2;
const FILES_PER_PAGE = 100;
const MAX_FILES = 3000;
const PURPOSE = 'commit-files';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const unavailable = () => new ApiError(502, 'files_unavailable', 'The complete file changes could not be verified. This commit is excluded while lockfile filtering is on.');

export interface FileSession { sessionId: string; user: { id: string }; token: string; expiresAt: number }
interface FileHandle {
  version: 1; purpose: typeof PURPOSE; sessionId: string; githubUserId: string;
  repositoryNodeId: string; isPrivate: boolean; oid: string; additions: number;
  deletions: number; parentCount: number; committedDate: string; changedFiles: number | null;
  page: number; fileCount: number; readAdditions: number; readDeletions: number; expiresAt: number;
}
interface LiveRepository { id: string; databaseId: number | null; nameWithOwner: string; isPrivate: boolean; isFork: boolean }
interface RestCommit {
  sha: string; author: { node_id: string } | null; parents: unknown[];
  commit: { committer: { date: string } | null };
  stats: { additions: number; deletions: number; total: number };
  files: { filename: string; previous_filename?: string; status: string; additions: number; deletions: number }[];
}

/** Only scan-discovered, primary-author, nonmerge commits receive a capability. */
export async function addFileHandles(
  env: CryptoEnvironment, session: FileSession,
  scope: { repositoryNodeId: string; isPrivate: boolean }, commits: CommitRecord[],
): Promise<CommitRecord[]> {
  const signer = await createSigner(env, PURPOSE);
  return Promise.all(commits.map(async (commit) => {
    if (commit.authorId !== session.user.id || commit.parentCount > 1) return commit;
    const handle: FileHandle = {
      version: 1, purpose: PURPOSE, sessionId: session.sessionId, githubUserId: session.user.id,
      repositoryNodeId: scope.repositoryNodeId, isPrivate: scope.isPrivate, oid: commit.oid,
      additions: commit.additions, deletions: commit.deletions, parentCount: commit.parentCount,
      committedDate: commit.committedDate, changedFiles: commit.changedFiles ?? null,
      page: 1, fileCount: 0, readAdditions: 0, readDeletions: 0, expiresAt: session.expiresAt,
    };
    return { ...commit, filesHandle: await signer(handle) };
  }));
}

async function readHandle(env: CryptoEnvironment, session: FileSession, input: Record<string, unknown>, verifyHandle?: (token: string) => Promise<FileHandle>): Promise<FileHandle> {
  try {
    if (Object.keys(input).length !== 1 || typeof input.handle !== 'string' || !input.handle || input.handle.length > 6000) throw new Error();
    const handle = verifyHandle ? await verifyHandle(input.handle) : await verify<FileHandle>(env, PURPOSE, input.handle);
    if (handle.version !== 1 || handle.purpose !== PURPOSE || handle.sessionId !== session.sessionId || handle.githubUserId !== session.user.id ||
      !integer(handle.expiresAt) || handle.expiresAt <= Date.now() / 1000 || handle.expiresAt > session.expiresAt ||
      !identifier(handle.repositoryNodeId) || typeof handle.isPrivate !== 'boolean' || !sha(handle.oid) ||
      !integer(handle.additions) || !integer(handle.deletions) || !integer(handle.parentCount) || handle.parentCount > 1 ||
      typeof handle.committedDate !== 'string' || !Number.isFinite(Date.parse(handle.committedDate)) ||
      (handle.changedFiles !== null && !integer(handle.changedFiles)) ||
      !integer(handle.page) || handle.page < 1 || handle.page > MAX_FILES / FILES_PER_PAGE ||
      !integer(handle.fileCount) || handle.fileCount !== (handle.page - 1) * FILES_PER_PAGE || handle.fileCount > MAX_FILES ||
      !integer(handle.readAdditions) || handle.readAdditions > handle.additions ||
      !integer(handle.readDeletions) || handle.readDeletions > handle.deletions ||
      (handle.page === 1 && (handle.readAdditions !== 0 || handle.readDeletions !== 0))) throw new Error();
    return handle;
  } catch { throw new ApiError(400, 'invalid_file_scan', 'These file details are expired or invalid. Start a new scan.'); }
}

function nextPage(link: string | null, pathname: string, canonicalPathname: string | null, page: number): number | null {
  if (!link) return null;
  if (link.length > 8192) throw unavailable();
  let next: number | null = null;
  for (const item of link.split(',')) {
    if (!/\brel\s*=\s*"?next\b/.test(item)) continue;
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(item);
    if (!match || next !== null) throw unavailable();
    let url: URL;
    try { url = new URL(match[1]); } catch { throw unavailable(); }
    if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash || (url.pathname !== pathname && url.pathname !== canonicalPathname) ||
      url.searchParams.getAll('page').length !== 1 || url.searchParams.getAll('per_page').length !== 1 ||
      url.searchParams.get('per_page') !== String(FILES_PER_PAGE) ||
      [...url.searchParams.keys()].some(key => key !== 'page' && key !== 'per_page')) throw unavailable();
    const value = url.searchParams.get('page')!;
    if (!/^[1-9]\d?$/.test(value) || Number(value) !== page + 1 || Number(value) > MAX_FILES / FILES_PER_PAGE) throw unavailable();
    next = Number(value);
  }
  return next;
}

function filename(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

const statuses = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
function sanitizeFiles(data: RestCommit): CommitFile[] {
  if (!Array.isArray(data.files) || data.files.length > FILES_PER_PAGE) throw unavailable();
  const seen = new Set<string>();
  return data.files.map((file) => {
    if (!file || !filename(file.filename) || seen.has(file.filename) || !statuses.has(file.status) ||
      !integer(file.additions) || !integer(file.deletions) ||
      (file.previous_filename !== undefined && !filename(file.previous_filename))) throw unavailable();
    seen.add(file.filename);
    // GitHub JSON may contain source patches and other URLs/identity fields.
    // Only this explicit metadata allowlist ever leaves the request; nothing is cached.
    return { filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions,
      ...(file.previous_filename !== undefined ? { previousFilename: file.previous_filename } : {}) };
  });
}

async function readRepository(session: FileSession, handles: FileHandle[]): Promise<LiveRepository> {
  const handle = handles[0];
  const { data: metadata } = await github<{ node: LiveRepository | null }>(session.token, '/graphql', {
    query: FILE_REPOSITORY_QUERY, variables: { id: handle.repositoryNodeId }, maxResponseBytes: 16 * 1024,
  });
  const repository = metadata.node;
  if (!repository) throw new ApiError(403, 'repository_unavailable', 'This repository is no longer available to your GitHub connection.');
  if (repository.id !== handle.repositoryNodeId || typeof repository.isPrivate !== 'boolean' || typeof repository.isFork !== 'boolean') throw unavailable();
  if (repository.databaseId != null && (!integer(repository.databaseId) || repository.databaseId < 1)) throw unavailable();
  if (repository.isFork) throw new ApiError(403, 'forks_excluded', 'Forked repositories are excluded from AI Diff. Choose a non-fork repository.');
  if (repository.isPrivate && handles.some(item => !item.isPrivate)) throw new ApiError(403, 'repository_visibility_changed', 'This repository became private. Select it from your private repositories and start a new scan.');
  const name = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/.exec(repository.nameWithOwner);
  if (!name || name[2] === '.' || name[2] === '..') throw unavailable();
  return repository;
}

async function readFilePage(env: CryptoEnvironment, session: FileSession, handle: FileHandle, repository: LiveRepository, maximum: number, signNext?: (value: FileHandle) => Promise<string>): Promise<FileScanPage> {
  // File counts are required to detect truncation, including omitted zero-line binary changes.
  if (handle.changedFiles === null || handle.changedFiles > MAX_FILES) throw unavailable();
  const name = repository.nameWithOwner.split('/');
  const pathname = `/repos/${encodeURIComponent(name[0])}/${encodeURIComponent(name[1])}/commits/${handle.oid}`;
  // GitHub's real pagination links use this numeric repository route. Accept
  // only the ID just resolved from the signed node; still construct our own
  // named request path below instead of following any returned URL.
  const canonicalPathname = repository.databaseId == null ? null : `/repositories/${repository.databaseId}/commits/${handle.oid}`;
  let result: { data: RestCommit; response: Response };
  try {
    result = await github<RestCommit>(session.token, `${pathname}?per_page=${FILES_PER_PAGE}&page=${handle.page}`, { maxResponseBytes: maximum });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'github_response_too_large') {
      if (maximum < FILE_RESPONSE_LIMIT) throw new ApiError(413, 'file_batch_retry_single', 'This file page needs a separate request. Retry the same handle with the single-file endpoint.');
      throw unavailable();
    }
    throw error;
  }
  const { data, response } = result;
  if (!data || data.sha !== handle.oid || data.author?.node_id !== session.user.id || !Array.isArray(data.parents) ||
    data.parents.length !== handle.parentCount || data.parents.length > 1 ||
    Date.parse(data.commit?.committer?.date ?? '') !== Date.parse(handle.committedDate) ||
    data.stats?.additions !== handle.additions || data.stats.deletions !== handle.deletions ||
    !integer(data.stats.total) || data.stats.total !== handle.additions + handle.deletions) throw unavailable();
  const files = sanitizeFiles(data);
  let additions = handle.readAdditions;
  let deletions = handle.readDeletions;
  for (const file of files) {
    additions += file.additions; deletions += file.deletions;
    if (!integer(additions) || !integer(deletions) || additions > handle.additions || deletions > handle.deletions) throw unavailable();
  }
  const count = handle.fileCount + files.length;
  const next = nextPage(response.headers.get('link'), pathname, canonicalPathname, handle.page);
  if (count > handle.changedFiles || count > MAX_FILES ||
    (next !== null && (files.length !== FILES_PER_PAGE || count >= handle.changedFiles)) ||
    (next === null && (count !== handle.changedFiles || additions !== handle.additions || deletions !== handle.deletions))) throw unavailable();
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  const resetHeader = response.headers.get('x-ratelimit-reset');
  const remaining = Number(remainingHeader);
  const reset = Number(resetHeader);
  if (!remainingHeader || !resetHeader || !integer(remaining) || !integer(reset) || reset < 1 || !Number.isFinite(new Date(reset * 1000).getTime())) throw unavailable();
  const nextHandle = next === null ? null : await (signNext ?? (value => sign(env, PURPOSE, value)))({
    ...handle, page: next, fileCount: count, readAdditions: additions, readDeletions: deletions,
  } satisfies FileHandle);
  return { oid: handle.oid, files, nextHandle, complete: next === null, remaining, resetAt: new Date(reset * 1000).toISOString() };
}

export async function scanCommitFiles(env: CryptoEnvironment, session: FileSession, input: Record<string, unknown>): Promise<FileScanPage> {
  const handle = await readHandle(env, session, input);
  if (handle.changedFiles === null || handle.changedFiles > MAX_FILES) throw unavailable();
  return readFilePage(env, session, handle, await readRepository(session, [handle]), FILE_RESPONSE_LIMIT);
}

export async function scanCommitFilesBatch(
  env: CryptoEnvironment, session: FileSession, input: Record<string, unknown>,
  charge?: (pages: number) => Promise<void>,
): Promise<FileScanBatch> {
  if (Object.keys(input).length !== 1 || !Array.isArray(input.handles) || input.handles.length < 1 || input.handles.length > FILE_BATCH_SIZE) {
    throw new ApiError(400, 'invalid_file_scan', 'Send one to four signed file handles from the same repository.');
  }
  // Verify the entire request before reading any repository or commit. A SHA
  // appears only once in a batch, including when handles refer to different pages.
  const verifier = await createVerifier(env, PURPOSE);
  const handles = await Promise.all(input.handles.map(handle => readHandle(env, session, { handle }, verifier<FileHandle>)));
  if (new Set(handles.map(handle => handle.oid)).size !== handles.length || handles.some(handle => handle.repositoryNodeId !== handles[0].repositoryNodeId)) {
    throw new ApiError(400, 'invalid_file_scan', 'Use distinct commits from the same repository in each file batch.');
  }
  await charge?.(handles.length);
  if (handles.length > FILE_BATCH_CONCURRENCY) {
    return { results: handles.map(handle => ({ oid: handle.oid, error: {
      code: 'file_batch_retry_single', message: 'This file batch needs separate requests. Retry each handle with the single-file endpoint.',
    } })) };
  }
  const repository = await readRepository(session, handles);
  let signer: Promise<(value: unknown) => Promise<string>> | undefined;
  const signNext = async (value: FileHandle) => (await (signer ??= createSigner(env, PURPOSE)))(value);
  // Two bounded bodies use at most 768 KiB of JSON parsing per invocation.
  // A heavy page is retried by itself with the existing 2 MiB limit.
  const pages = await Promise.allSettled(handles.map(handle => readFilePage(env, session, handle, repository, FILE_BATCH_RESPONSE_LIMIT, signNext)));
  for (const page of pages) {
    if (page.status === 'rejected' && page.reason instanceof ApiError && ['authentication_required', 'session_expired', 'repository_unavailable', 'repository_visibility_changed', 'forks_excluded'].includes(page.reason.code)) throw page.reason;
  }
  return { results: pages.map((page, index) => {
    const oid = handles[index].oid;
    if (page.status === 'fulfilled') return { oid, page: page.value };
    const error = page.reason instanceof ApiError ? page.reason : new ApiError(502, 'github_unavailable', 'GitHub could not complete this file request. Please retry.');
    return { oid, error: { code: error.code, message: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } };
  }) };
}
