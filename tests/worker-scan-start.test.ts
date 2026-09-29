import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../worker/index';
import type { ScanPage, ScanStart } from '../shared/types';
import { cookieName, seal, verify } from '../worker/security';

const env: Env = {
  APP_ORIGIN: 'https://aidiff.example.com', GITHUB_APP_SLUG: 'ai-diff-test', GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'), ASSETS: { fetch: async () => new Response('app') },
};
const viewer = { id: 'U_author', login: 'author', avatarUrl: '' };
const repository = { id: 'R_repo', nameWithOwner: 'author/project', isPrivate: false, isFork: false, isArchived: false, description: null };
const head = 'a'.repeat(40);
const cutoff = '2026-01-01T00:00:00.000Z';
const rateLimit = { remaining: 4500, resetAt: '2026-01-01T01:00:00Z' };
const commit = (oid = 'b'.repeat(40), authorId = viewer.id, parents = 1) => ({
  oid, additions: 17, deletions: 4, committedDate: '2025-12-01T00:00:00Z', messageHeadline: 'A change', changedFilesIfAvailable: 2,
  author: { user: { id: authorId } }, parents: { totalCount: parents },
});
const connection = (nodes = [commit()], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
let githubFetch: ReturnType<typeof vi.fn<typeof fetch>>;
let sessionCookie: string;
const post = (path: string, body: unknown) => new Request(`${env.APP_ORIGIN}${path}`, {
  method: 'POST', headers: { Cookie: sessionCookie, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'x-csrf-token': 'csrf' }, body: JSON.stringify(body),
});
const input = (overrides = {}) => ({ repositoryId: repository.id, includePrivate: false, includeFirstPage: true, asOf: cutoff, ...overrides });
const snapshot = (history = connection(), overrides = {}) => ({
  data: { node: { ...repository, defaultBranchRef: { target: { oid: head, history } }, ...overrides }, rateLimit },
});

beforeEach(async () => {
  githubFetch = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', githubFetch);
  sessionCookie = `${cookieName(env, 'session')}=${await seal(env, 'session', {
    version: 1, sessionId: 'session', user: viewer, token: 'ghu_never-return', csrfToken: 'csrf', expiresAt: Math.floor(Date.now() / 1000) + 3600,
  })}`;
});
afterEach(() => vi.unstubAllGlobals());

describe('combined snapshot and initial history page', () => {
  it('uses one bounded query and binds the continuation and file handles to the same snapshot', async () => {
    const primary = commit(); const coauthor = commit('c'.repeat(40), 'U_other'); const merge = commit('d'.repeat(40), viewer.id, 2);
    githubFetch.mockResolvedValueOnce(response(snapshot(connection([primary, coauthor, merge], 'cursor-100'))));
    const result = await worker.fetch(post('/api/scan/start', input()), env);
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    const start = await result.json() as ScanStart;
    expect(githubFetch).toHaveBeenCalledOnce();
    const query = JSON.parse(String(githubFetch.mock.calls[0][1]?.body));
    expect(query.query).toContain('query SnapshotWithHistory');
    expect(query.query).toContain('history(first: 100');
    expect(query.variables).toEqual({ id: repository.id, author: viewer.id, until: cutoff });
    expect(start.repository).toEqual(repository); expect(start.empty).toBe(false);
    expect(start.initialPage?.commits.map(item => item.oid)).toEqual([primary.oid, merge.oid]);
    expect(start.initialPage?.commits[0].filesHandle).toBeTypeOf('string');
    expect(start.initialPage?.commits[1].filesHandle).toBeUndefined();
    expect(start.handle).toBe(start.initialPage?.nextHandle);
    expect(await verify(env, 'scan-page', start.handle!)).toMatchObject({ headOid: head, after: 'cursor-100', asOf: cutoff, sessionId: 'session', githubUserId: viewer.id });
    expect(await verify(env, 'commit-files', start.initialPage!.commits[0].filesHandle!)).toMatchObject({ repositoryNodeId: repository.id, oid: primary.oid, additions: 17, deletions: 4, githubUserId: viewer.id });
    expect(JSON.stringify(start)).not.toContain('ghu_never-return');

    // Advancing the real branch cannot change the signed continuation's HEAD.
    githubFetch.mockResolvedValueOnce(response({ data: { node: { isPrivate: false, isFork: false, object: { history: connection([commit('e'.repeat(40))]) } }, rateLimit } }));
    const pageResponse = await worker.fetch(post('/api/scan/page', { handle: start.handle }), env);
    expect(pageResponse.status).toBe(200);
    const nextQuery = JSON.parse(String(githubFetch.mock.calls[1][1]?.body));
    expect(nextQuery.variables).toMatchObject({ head, after: 'cursor-100', until: cutoff });
    expect((await pageResponse.json() as ScanPage).nextHandle).toBeNull();
  });

  it('finishes a small repository without requesting its first page again', async () => {
    githubFetch.mockResolvedValueOnce(response(snapshot()));
    const result = await worker.fetch(post('/api/scan/start', input()), env);
    const start = await result.json() as ScanStart;
    expect(start.handle).toBeNull(); expect(start.initialPage?.nextHandle).toBeNull();
    expect(start.initialPage?.commits).toHaveLength(1); expect(githubFetch).toHaveBeenCalledOnce();
  });

  it('distinguishes an empty repository from a nonempty repository with no matching commits', async () => {
    githubFetch.mockResolvedValueOnce(response(snapshot(connection(), { defaultBranchRef: null })));
    const empty = await worker.fetch(post('/api/scan/start', input()), env);
    expect(await empty.json()).toEqual({ repository, empty: true, handle: null });
    githubFetch.mockResolvedValueOnce(response(snapshot(connection([]))));
    const unmatched = await worker.fetch(post('/api/scan/start', input()), env);
    expect(await unmatched.json()).toMatchObject({ empty: false, handle: null, initialPage: { commits: [], nextHandle: null } });
  });

  it.each([
    [{ isPrivate: true }, 'private_consent_required', 403],
    [{ isFork: true }, 'forks_excluded', 403],
    [{ isPrivate: undefined }, 'github_incomplete', 502],
    [{ defaultBranchRef: undefined }, 'github_incomplete', 502],
    [{ id: 'R_other' }, 'repository_unavailable', 403],
  ])('does not expose first-page history for disallowed repository metadata %j', async (overrides, code, status) => {
    githubFetch.mockResolvedValueOnce(response(snapshot(connection(), overrides)));
    const result = await worker.fetch(post('/api/scan/start', input()), env);
    expect(result.status).toBe(status);
    expect(await result.json()).toMatchObject({ error: { code } });
    expect(githubFetch).toHaveBeenCalledOnce();
  });

  it('supports explicitly selected private repositories', async () => {
    githubFetch.mockResolvedValueOnce(response(snapshot(connection(), { isPrivate: true })));
    const result = await worker.fetch(post('/api/scan/start', input({ includePrivate: true })), env);
    const start = await result.json() as ScanStart;
    expect(result.status).toBe(200); expect(start.repository.isPrivate).toBe(true);
    expect(await verify(env, 'commit-files', start.initialPage!.commits[0].filesHandle!)).toMatchObject({ isPrivate: true });
  });

  it.each([
    { nodes: [commit()], pageInfo: { hasNextPage: true, endCursor: null } },
    { nodes: [commit()], pageInfo: { hasNextPage: 'yes', endCursor: 'next' } },
    { nodes: Array.from({ length: 101 }, () => commit()), pageInfo: { hasNextPage: false, endCursor: null } },
    { nodes: [{ ...commit(), additions: -1 }], pageInfo: { hasNextPage: false, endCursor: null } },
  ])('rejects malformed first-page history rather than claiming a complete result', async history => {
    githubFetch.mockResolvedValueOnce(response({ data: { node: { ...repository, defaultBranchRef: { target: { oid: head, history } } }, rateLimit } }));
    const result = await worker.fetch(post('/api/scan/start', input()), env);
    expect(result.status).toBe(502); expect(await result.json()).toMatchObject({ error: { code: 'github_incomplete' } });
  });

  it('rejects missing initial history, missing rate information, and GraphQL partial results', async () => {
    const missingHistory = snapshot(); delete (missingHistory.data.node.defaultBranchRef.target as { history?: unknown }).history;
    const missingRate = snapshot(); delete (missingRate.data as { rateLimit?: unknown }).rateLimit;
    for (const payload of [missingHistory, missingRate, { ...snapshot(), errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED', message: 'truncated' }] }]) {
      githubFetch.mockResolvedValueOnce(response(payload));
      const result = await worker.fetch(post('/api/scan/start', input()), env);
      expect(result.status).toBe(502); expect(await result.json()).toMatchObject({ error: { code: 'github_incomplete' } });
    }
  });

  it('retains the original start contract when the optimization is omitted or disabled', async () => {
    for (const includeFirstPage of [undefined, false]) {
      githubFetch.mockResolvedValueOnce(response(snapshot()));
      const result = await worker.fetch(post('/api/scan/start', input({ includeFirstPage })), env);
      const start = await result.json() as ScanStart;
      expect(start.initialPage).toBeUndefined(); expect(start.handle).toBeTypeOf('string');
      expect(await verify(env, 'scan-page', start.handle!)).toMatchObject({ headOid: head, after: null });
      const query = JSON.parse(String(githubFetch.mock.calls.at(-1)![1]?.body));
      expect(query.query).not.toContain('history('); expect(query.variables).toEqual({ id: repository.id });
    }
  });

  it('rejects a nonboolean includeFirstPage before making requests', async () => {
    const result = await worker.fetch(post('/api/scan/start', input({ includeFirstPage: 'yes' })), env);
    expect(result.status).toBe(400); expect(githubFetch).not.toHaveBeenCalled();
  });
});
