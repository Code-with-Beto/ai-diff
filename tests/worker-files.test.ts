import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../worker/index';
import type { FileScanBatch, FileScanPage, ScanPage } from '../shared/types';
import { FILE_BATCH_BODY_LIMIT, FILE_BATCH_RESPONSE_LIMIT, FILE_RESPONSE_LIMIT } from '../worker/commit-files';
import { cookieName, seal, sign, verify } from '../worker/security';

const env: Env = {
  APP_ORIGIN: 'https://aidiff.example.com', GITHUB_APP_SLUG: 'ai-diff-test', GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'), ASSETS: { fetch: async () => new Response('unused') },
};
const viewer = { id: 'U_test', login: 'test-user', avatarUrl: 'https://avatars.githubusercontent.com/u/1' };
const oid = 'a'.repeat(40);
const committedDate = '2025-08-10T12:00:00Z';
const repository = { id: 'R_test', databaseId: 849003495, nameWithOwner: 'test-user/project', isPrivate: false, isFork: false };
const resetAt = '2026-10-01T00:00:00.000Z';
const rateHeaders = { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Date.parse(resetAt) / 1000) };
const response = (data: unknown, headers: Record<string, string> = {}, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const file = (filename: string, additions = 1, deletions = 0) => ({ filename, status: 'modified', additions, deletions });
const baseFiles = [file('src/app.ts', 8, 3), { ...file('package-lock.json', 3, 1), previous_filename: 'nested/package-lock.json', status: 'renamed' }];
const restCommit = (overrides = {}) => ({
  sha: oid, author: { node_id: viewer.id, email: 'private@example.invalid' }, parents: [{ sha: 'b'.repeat(40) }],
  commit: { committer: { date: committedDate }, message: 'Do not forward the full message' },
  stats: { additions: 11, deletions: 4, total: 15 }, files: baseFiles, ...overrides,
});
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let sessionCookie: string;
let expiresAt: number;
const post = (input: unknown, headers: Record<string, string> = {}) => new Request(`${env.APP_ORIGIN}/api/scan/files`, {
  method: 'POST', headers: { Cookie: sessionCookie, Origin: env.APP_ORIGIN, 'x-csrf-token': 'csrf-test', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
});
const postBatch = (input: unknown, headers: Record<string, string> = {}) => new Request(`${env.APP_ORIGIN}/api/scan/files/batch`, post(input, headers));
const metadata = (overrides = {}) => response({ data: { node: { ...repository, ...overrides } } });
async function handle(overrides = {}) {
  return sign(env, 'commit-files', {
    version: 1, purpose: 'commit-files', sessionId: 'session-one', githubUserId: viewer.id,
    repositoryNodeId: repository.id, isPrivate: false, oid, additions: 11, deletions: 4,
    parentCount: 1, committedDate, changedFiles: 2, page: 1, fileCount: 0, readAdditions: 0, readDeletions: 0,
    expiresAt, ...overrides,
  });
}
async function fetchPage(token: string, rest = restCommit(), headers: Record<string, string> = {}) {
  upstream.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(response(rest, { ...rateHeaders, ...headers }));
  return worker.fetch(post({ handle: token }), env);
}
beforeEach(async () => {
  expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sessionCookie = `${cookieName(env, 'session')}=${await seal(env, 'session', { version: 1, sessionId: 'session-one', user: viewer, token: 'ghu_fake-token', csrfToken: 'csrf-test', expiresAt })}`;
  upstream = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => vi.unstubAllGlobals());

describe('commit file capability and request boundaries', () => {
  it('issues scoped handles only for primary-author nonmerge history and keeps raw statistics', async () => {
    const scanHandle = await sign(env, 'scan-page', { version: 1, purpose: 'scan-page', sessionId: 'session-one', githubUserId: viewer.id, repositoryNodeId: repository.id, headOid: oid, isPrivate: false, after: null, asOf: '2026-01-01T00:00:00Z', expiresAt });
    const commit = { oid, additions: 11, deletions: 4, committedDate, author: { user: { id: viewer.id } }, parents: { totalCount: 1 }, changedFilesIfAvailable: 2, messageHeadline: 'A'.repeat(300) };
    upstream.mockResolvedValueOnce(response({ data: {
      node: { isPrivate: false, isFork: false, object: { history: { nodes: [commit, { ...commit, oid: 'b'.repeat(40), parents: { totalCount: 2 } }, { ...commit, oid: 'c'.repeat(40), author: { user: { id: 'other' } } }], pageInfo: { hasNextPage: false, endCursor: null } } } },
      rateLimit: { remaining: 4500, resetAt },
    } }));
    const request = post({ handle: scanHandle });
    const result = await worker.fetch(new Request(`${env.APP_ORIGIN}/api/scan/page`, request), env);
    const data = await result.json() as ScanPage;
    expect(result.status).toBe(200);
    expect(data.commits).toHaveLength(2);
    expect(data.commits[0]).toMatchObject({ oid, additions: 11, deletions: 4, changedFiles: 2, headline: 'A'.repeat(240), filesHandle: expect.any(String) });
    expect(data.commits[1]).not.toHaveProperty('filesHandle');
    expect(await verify(env, 'commit-files', data.commits[0].filesHandle!)).toMatchObject({ sessionId: 'session-one', githubUserId: viewer.id, repositoryNodeId: repository.id, oid, isPrivate: false, additions: 11, deletions: 4, changedFiles: 2 });
    expect(String(upstream.mock.calls[0][1]?.body)).toContain('changedFilesIfAvailable');
  });

  it.each([
    ['authentication', { Cookie: '' }, 401],
    ['CSRF', { 'x-csrf-token': 'wrong' }, 403],
    ['origin', { Origin: 'https://other.invalid' }, 403],
  ] as const)('requires %s before GitHub access', async (_, headers, status) => {
    expect((await worker.fetch(post({ handle: await handle() }, headers), env)).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'other-session' }, { githubUserId: 'other-user' }, { expiresAt: 1 },
    { parentCount: 2 }, { oid: '../escape' }, { page: 0 }, { page: 31 }, { fileCount: 1 },
  ])('rejects invalid or reused capabilities %j without GitHub access', async (overrides) => {
    const result = await worker.fetch(post({ handle: await handle(overrides) }), env);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: { code: 'invalid_file_scan' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects tampering and extra URL/page parameters', async () => {
    const token = await handle();
    const altered = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
    expect((await worker.fetch(post({ handle: altered }), env)).status).toBe(400);
    expect((await worker.fetch(post({ handle: token, url: 'https://other.invalid', page: 4 }), env)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('has independent per-user and IP limits, without consuming the general API limiter', async () => {
    const fileLimit = vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const apiLimit = vi.fn().mockResolvedValue({ success: false });
    const result = await worker.fetch(post({ handle: await handle() }, { 'CF-Connecting-IP': '192.0.2.10' }), { ...env, FILE_LIMITER: { limit: fileLimit }, API_LIMITER: { limit: apiLimit } });
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 60 } });
    expect(fileLimit.mock.calls).toEqual([[{ key: `files:user:${viewer.id}` }], [{ key: 'files:ip:192.0.2.10' }]]);
    expect(apiLimit).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('complete, sanitized file metadata', () => {
  it('returns only permitted fields with no source patches, emails, message bodies, or upstream URLs', async () => {
    const result = await fetchPage(await handle(), restCommit({ files: baseFiles.map(value => ({ ...value, patch: 'SENSITIVE_SOURCE_CONTENT', raw_url: 'https://secret.invalid', blob_url: 'https://secret.invalid' })) }));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const data = await result.json();
    expect(data).toEqual({ oid, complete: true, nextHandle: null, remaining: 4000, resetAt, files: [file('src/app.ts', 8, 3), { ...file('package-lock.json', 3, 1), status: 'renamed', previousFilename: 'nested/package-lock.json' }] });
    expect(JSON.stringify(data)).not.toMatch(/SENSITIVE_SOURCE|private@example|raw_url|blob_url|message/);
    expect(upstream.mock.calls[1][0]).toBe(`https://api.github.com/repos/test-user/project/commits/${oid}?per_page=100&page=1`);
  });

  it('preserves zero-line binary changes and empty commits when file counts verify them', async () => {
    const result = await fetchPage(await handle({ additions: 0, deletions: 0, changedFiles: 1 }), restCommit({ stats: { additions: 0, deletions: 0, total: 0 }, files: [file('icon.png', 0, 0)] }));
    expect(await result.json()).toMatchObject({ complete: true, files: [file('icon.png', 0, 0)] });
    const empty = await fetchPage(await handle({ additions: 0, deletions: 0, changedFiles: 0 }), restCommit({ stats: { additions: 0, deletions: 0, total: 0 }, files: [] }));
    expect(await empty.json()).toMatchObject({ complete: true, files: [] });
  });

  it.each([
    { sha: 'b'.repeat(40) }, { author: { node_id: 'other-user' } }, { author: null },
    { parents: [{}, {}] }, { commit: { committer: { date: '2025-08-11T12:00:00Z' } } },
    { stats: { additions: 10, deletions: 4, total: 14 } },
    { files: [file('src/app.ts', 7, 3), file('package-lock.json', 3, 1)] },
    { files: [file('src/app.ts', 11, 4)] },
    { files: [file('same', 8, 3), file('same', 3, 1)] },
    { files: [file('src/app.ts', -1, 3), file('package-lock.json', 12, 1)] },
    { files: undefined },
  ])('refuses mismatched identity, incomplete data, or invalid file totals %j', async (overrides) => {
    const result = await fetchPage(await handle(), restCommit(overrides));
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: 'files_unavailable' } });
  });

  it.each([null, 3001])('fails explicitly when the known file count is %s', async (changedFiles) => {
    const result = await worker.fetch(post({ handle: await handle({ changedFiles }) }), env);
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: 'files_unavailable' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [{ isPrivate: true }, 'repository_visibility_changed'], [{ isFork: true }, 'forks_excluded'],
    [{ isPrivate: undefined }, 'files_unavailable'], [{ isFork: undefined }, 'files_unavailable'],
  ] as const)('rechecks visibility and forks before file reads %j', async (overrides, code) => {
    upstream.mockResolvedValueOnce(metadata(overrides));
    const result = await worker.fetch(post({ handle: await handle() }), env);
    expect(await result.json()).toMatchObject({ error: { code } });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('permits explicitly selected private repository details with current access', async () => {
    upstream.mockResolvedValueOnce(metadata({ isPrivate: true })).mockResolvedValueOnce(response(restCommit(), rateHeaders));
    expect((await worker.fetch(post({ handle: await handle({ isPrivate: true }) }), env)).status).toBe(200);
  });

  it('rejects an oversized upstream body, even when Content-Length is absent', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(FILE_RESPONSE_LIMIT + 1)); },
      cancel() { cancelled = true; },
    });
    upstream.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(new Response(body));
    const result = await worker.fetch(post({ handle: await handle() }), env);
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: 'files_unavailable' } });
    expect(cancelled).toBe(true);
  });

  it('preserves GitHub retry guidance without returning raw error detail', async () => {
    upstream.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(response({ message: 'sensitive upstream detail' }, { 'retry-after': '90' }, 429));
    const result = await worker.fetch(post({ handle: await handle() }), env);
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 90 } });
  });
});

describe('bounded file pagination', () => {
  const stats = { additions: 101, deletions: 0, total: 101 };
  const firstFiles = Array.from({ length: 100 }, (_, index) => file(`source/${index}.ts`));
  const path = `https://api.github.com/repos/test-user/project/commits/${oid}`;
  it('validates all pages and never adds repeated static commit stats to file sums', async () => {
    const token = await handle({ additions: 101, deletions: 0, changedFiles: 101 });
    const firstResponse = await fetchPage(token, restCommit({ stats, files: firstFiles }), { link: `<${path}?per_page=100&page=2>; rel="next", <${path}?per_page=100&page=2>; rel="last"` });
    const first = await firstResponse.json() as FileScanPage;
    expect(firstResponse.status).toBe(200);
    expect(first.complete).toBe(false);
    expect(first.files).toHaveLength(100);
    expect(await verify(env, 'commit-files', first.nextHandle!)).toMatchObject({ page: 2, fileCount: 100, readAdditions: 100, readDeletions: 0 });
    const lastResponse = await fetchPage(first.nextHandle!, restCommit({ stats, files: [file('source/last.ts')] }));
    const last = await lastResponse.json() as FileScanPage;
    expect(lastResponse.status).toBe(200);
    expect(last).toMatchObject({ complete: true, nextHandle: null, files: [file('source/last.ts')] });
    expect([...first.files, ...last.files].reduce((sum, item) => sum + item.additions, 0)).toBe(stats.additions);
    expect(upstream.mock.calls[3][0]).toBe(`${path}?per_page=100&page=2`);
  });

  it('accepts GitHub numeric pagination only for the trusted live repository ID and reconstructs the request', async () => {
    const token = await handle({ additions: 101, deletions: 0, changedFiles: 101 });
    const firstResponse = await fetchPage(token, restCommit({ stats, files: firstFiles }), {
      link: `<https://api.github.com/repositories/${repository.databaseId}/commits/${oid}?per_page=100&page=2>; rel="next"`,
    });
    const first = await firstResponse.json() as FileScanPage;
    expect(firstResponse.status).toBe(200);
    expect(first.complete).toBe(false);
    const lastResponse = await fetchPage(first.nextHandle!, restCommit({ stats, files: [file('source/last.ts')] }));
    expect(lastResponse.status).toBe(200);
    expect(await lastResponse.json()).toMatchObject({ complete: true, nextHandle: null });
    // The capability selects the repository. An upstream URL is never fetched.
    expect(upstream.mock.calls[3][0]).toBe(`${path}?per_page=100&page=2`);
  });

  it('refuses a missing next page even if missing binary files would not change totals', async () => {
    const result = await fetchPage(await handle({ additions: 100, deletions: 0, changedFiles: 101 }), restCommit({ stats: { additions: 100, deletions: 0, total: 100 }, files: firstFiles }));
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: 'files_unavailable' } });
  });

  it.each([
    `https://evil.invalid/commits/${oid}?per_page=100&page=2`,
    `${path}?per_page=100&page=1`, `${path}?per_page=100&page=3`,
    `${path}?per_page=99&page=2`, `${path}?per_page=100&page=2&url=secret`,
    `https://api.github.com/repositories/123/commits/${oid}?per_page=100&page=2`,
    `https://api.github.com/repositories/${repository.databaseId}/commits/${'b'.repeat(40)}?per_page=100&page=2`,
  ])('never follows unsafe or out-of-sequence pagination %s', async (next) => {
    const result = await fetchPage(await handle({ additions: 101, deletions: 0, changedFiles: 101 }), restCommit({ stats, files: firstFiles }), { link: `<${next}>; rel="next"` });
    expect(result.status).toBe(502);
    expect(await result.json()).toMatchObject({ error: { code: 'files_unavailable' } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('accepts exactly 3000 files only when the final page and raw totals agree', async () => {
    const token = await handle({ additions: 3000, deletions: 0, changedFiles: 3000, page: 30, fileCount: 2900, readAdditions: 2900 });
    const result = await fetchPage(token, restCommit({ stats: { additions: 3000, deletions: 0, total: 3000 }, files: firstFiles }));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ complete: true, nextHandle: null });
  });
});

describe('bounded concurrent file batches', () => {
  const oids = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(40));
  const handles = (count = 2) => Promise.all(oids.slice(0, count).map(oid => handle({ oid })));

  it.each([{ Cookie: '' }, { Origin: 'https://other.invalid' }, { 'x-csrf-token': 'wrong' }] as Record<string, string>[])('requires session, origin and CSRF before batch reads (%j)', async headers => {
    const result = await worker.fetch(postBatch({ handles: await handles() }, headers), env);
    expect(result.status).toBe(headers.Cookie === '' ? 401 : 403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([{}, { handles: [] }, { handles: ['a', 'b', 'c', 'd', 'e'] }, { handles: ['a'], url: 'https://other.invalid' }, { handles: [null] }, { handles: ['a'.repeat(6001)] }])('rejects invalid batch envelopes before GitHub (%j)', async input => {
    expect((await worker.fetch(postBatch(input), env)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bounds the request body before capability verification', async () => {
    const result = await worker.fetch(postBatch({ handles: ['x'.repeat(FILE_BATCH_BODY_LIMIT)] }), env);
    expect(result.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('validates every capability and rejects duplicate commits or different repositories before metadata', async () => {
    const good = await handle();
    const values = [
      [good, 'tampered'],
      [good, await handle({ oid: oids[1], sessionId: 'other-session' })],
      [good, await handle({ oid: oids[1], repositoryNodeId: 'another-repository' })],
      [good, good],
      [good, await handle({ page: 2, fileCount: 100, changedFiles: 101, additions: 101, deletions: 0, readAdditions: 100 })],
    ];
    const charge = vi.fn().mockResolvedValue({ success: true });
    for (const input of values) expect((await worker.fetch(postBatch({ handles: input }), { ...env, FILE_LIMITER: { limit: charge } })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    // Invalid authenticated envelopes still consume one user/IP allowance.
    expect(charge).toHaveBeenCalledTimes(values.length * 2);
  });

  it('resolves repository access once, launches two bounded reads, and retains input order without leaking upstream fields', async () => {
    const release: (() => void)[] = [];
    let active = 0, maximum = 0;
    upstream.mockImplementation(async url => {
      if (String(url).endsWith('/graphql')) return metadata();
      const sha = /\/commits\/([a-f0-9]+)\?/.exec(String(url))![1];
      active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => release.push(resolve));
      active -= 1;
      return response(restCommit({ sha, files: baseFiles.map(file => ({ ...file, patch: 'SECRET_PATCH', raw_url: 'SECRET_URL' })) }), rateHeaders);
    });
    const charge = vi.fn().mockResolvedValue({ success: true });
    const general = vi.fn().mockResolvedValue({ success: false });
    const pending = worker.fetch(postBatch({ handles: await handles() }, { 'CF-Connecting-IP': '192.0.2.10' }), { ...env, FILE_LIMITER: { limit: charge }, API_LIMITER: { limit: general } });
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.reverse().forEach(resolve => resolve());
    const result = await pending;
    const data = await result.json() as FileScanBatch;
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(data.results.map(item => item.oid)).toEqual(oids.slice(0, 2));
    expect(data.results.every(item => 'page' in item && item.page.complete && item.page.oid === item.oid)).toBe(true);
    expect(maximum).toBe(2);
    expect(upstream.mock.calls.filter(([url]) => String(url).endsWith('/graphql'))).toHaveLength(1);
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(data)).not.toMatch(/SECRET|private@example|patch|raw_url|message/);
    expect(general).not.toHaveBeenCalled();
    expect(charge.mock.calls).toEqual(Array.from({ length: 2 }, () => [[{ key: `files:user:${viewer.id}` }], [{ key: 'files:ip:192.0.2.10' }]]).flat());
  });

  it.each([3, 4])('keeps legacy %i-handle envelopes safe with verified, charged individual fallbacks and no GitHub reads', async count => {
    const charge = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(postBatch({ handles: await handles(count) }), { ...env, FILE_LIMITER: { limit: charge } });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    const data = await result.json() as FileScanBatch;
    expect(data.results.map(item => item.oid)).toEqual(oids.slice(0, count));
    expect(data.results.every(item => 'error' in item && item.error.code === 'file_batch_retry_single')).toBe(true);
    expect(charge).toHaveBeenCalledTimes(count * 2);
    expect(upstream).not.toHaveBeenCalled();
    const invalid = await handles(count);
    invalid[count - 1] = 'tampered';
    expect((await worker.fetch(postBatch({ handles: invalid }), env)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('charges each requested page before upstream reads and refuses a batch when a page allowance fails', async () => {
    const charge = vi.fn().mockResolvedValue({ success: true }).mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const result = await worker.fetch(postBatch({ handles: await handles() }), { ...env, FILE_LIMITER: { limit: charge } });
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 60 } });
    expect(charge).toHaveBeenCalledTimes(3);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    [{ isPrivate: true }, 'repository_visibility_changed'], [{ isFork: true }, 'forks_excluded'], [{ id: 'wrong' }, 'files_unavailable'],
  ] as const)('treats repository validation as a global failure before REST (%j)', async (overrides, code) => {
    upstream.mockResolvedValueOnce(metadata(overrides));
    const result = await worker.fetch(postBatch({ handles: await handles() }), env);
    expect(await result.json()).toMatchObject({ error: { code } });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('checks the private authorization of every handle against the shared live metadata', async () => {
    upstream.mockResolvedValueOnce(metadata({ isPrivate: true }));
    const result = await worker.fetch(postBatch({ handles: [await handle({ isPrivate: true }), await handle({ oid: oids[1], isPrivate: false })] }), env);
    expect(result.status).toBe(403);
    expect(await result.json()).toMatchObject({ error: { code: 'repository_visibility_changed' } });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('retains successes beside rate limits, malformed pages and heavy-page fallbacks, then accepts the exact heavy handle alone', async () => {
    let cancelled = false;
    upstream.mockImplementation(async url => {
      if (String(url).endsWith('/graphql')) return metadata();
      const sha = /\/commits\/([a-f0-9]+)\?/.exec(String(url))![1];
      if (sha === oids[1]) return response({ message: 'SECRET_RATE_DETAIL' }, { 'retry-after': '90' }, 429);
      if (sha === oids[2]) return response(restCommit({ sha, stats: { additions: 999, deletions: 4, total: 1003 } }), rateHeaders);
      if (sha === oids[3]) return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(FILE_BATCH_RESPONSE_LIMIT + 1)); }, cancel() { cancelled = true; } }));
      return response(restCommit({ sha }), rateHeaders);
    });
    const tokens = await handles(4);
    const data: FileScanBatch = { results: [] };
    for (let index = 0; index < tokens.length; index += 2) {
      const result = await worker.fetch(postBatch({ handles: tokens.slice(index, index + 2) }), env);
      expect(result.status).toBe(200);
      data.results.push(...(await result.json() as FileScanBatch).results);
    }
    expect(data.results[0]).toMatchObject({ oid: oids[0], page: { complete: true } });
    expect(data.results[1]).toMatchObject({ oid: oids[1], error: { code: 'rate_limited', retryAfter: 90 } });
    expect(data.results[2]).toMatchObject({ oid: oids[2], error: { code: 'files_unavailable' } });
    expect(data.results[3]).toMatchObject({ oid: oids[3], error: { code: 'file_batch_retry_single' } });
    expect(JSON.stringify(data)).not.toContain('SECRET_RATE_DETAIL');
    expect(cancelled).toBe(true);
    upstream.mockImplementation(async url => String(url).endsWith('/graphql') ? metadata() : response(restCommit({ sha: oids[3], files: baseFiles.map(file => ({ ...file, patch: 'x'.repeat(FILE_BATCH_RESPONSE_LIMIT) })) }), rateHeaders));
    const single = await worker.fetch(post({ handle: tokens[3] }), env);
    expect(single.status).toBe(200);
    expect(await single.json()).toMatchObject({ oid: oids[3], complete: true, files: expect.any(Array) });
  });

  it('returns authentication or lost-access failures globally instead of keeping a stale partial batch', async () => {
    for (const status of [401, 404]) {
      upstream.mockImplementation(async url => {
        if (String(url).endsWith('/graphql')) return metadata();
        return String(url).includes(oids[1]) ? response({ message: 'SECRET' }, {}, status) : response(restCommit({ sha: oid }), rateHeaders);
      });
      const result = await worker.fetch(postBatch({ handles: [await handle(), await handle({ oid: oids[1] })] }), env);
      expect(result.status).toBe(status === 401 ? 401 : 403);
      expect(await result.json()).toMatchObject({ error: { code: status === 401 ? 'session_expired' : 'repository_unavailable' } });
    }
  });

  it('preserves signed continuation pages and their exact cumulative file totals', async () => {
    const token = await handle({ additions: 101, deletions: 0, changedFiles: 101 });
    upstream.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(response(restCommit({ stats: { additions: 101, deletions: 0, total: 101 }, files: Array.from({ length: 100 }, (_, index) => file(`src/${index}.ts`)) }), { ...rateHeaders, link: `<https://api.github.com/repositories/${repository.databaseId}/commits/${oid}?per_page=100&page=2>; rel="next"` }));
    const first = await (await worker.fetch(postBatch({ handles: [token] }), env)).json() as FileScanBatch;
    expect(first.results[0]).toMatchObject({ oid, page: { complete: false, nextHandle: expect.any(String) } });
    if (!('page' in first.results[0])) throw new Error('Expected page');
    expect(await verify(env, 'commit-files', first.results[0].page.nextHandle!)).toMatchObject({ page: 2, fileCount: 100, readAdditions: 100, readDeletions: 0 });
    upstream.mockResolvedValueOnce(metadata()).mockResolvedValueOnce(response(restCommit({ stats: { additions: 101, deletions: 0, total: 101 }, files: [file('src/last.ts')] }), rateHeaders));
    const last = await (await worker.fetch(postBatch({ handles: [first.results[0].page.nextHandle] }), env)).json();
    expect(last).toMatchObject({ results: [{ oid, page: { complete: true, nextHandle: null } }] });
  });
});
