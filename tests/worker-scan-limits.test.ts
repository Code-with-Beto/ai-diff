import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../worker/index';
import { cookieName, seal, sign } from '../worker/security';

const env: Env = {
  APP_ORIGIN: 'https://aidiff.example.com', GITHUB_APP_SLUG: 'ai-diff-test', GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-secret',
  SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'), ASSETS: { fetch: async () => new Response('app') },
};
const viewer = { id: 'U_author', login: 'author', avatarUrl: '' };
const repository = { id: 'R_repo', nameWithOwner: 'author/project', isPrivate: false, isFork: false, isArchived: false, description: null };
const asOf = '2026-01-01T00:00:00.000Z';
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let sessionCookie: string;
let expiredCookie: string;
let handle: string;
const session = (expiresAt: number) => ({ version: 1, sessionId: 'session', user: viewer, token: 'ghu_never-return', csrfToken: 'csrf', expiresAt });
const response = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
function post(path: string, overrides: Record<string, string> = {}, input?: unknown) {
  return new Request(`${env.APP_ORIGIN}${path}`, {
    method: 'POST', headers: { Cookie: sessionCookie, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'x-csrf-token': 'csrf', 'CF-Connecting-IP': '192.0.2.10', ...overrides },
    body: JSON.stringify(input ?? (path === '/api/scan/start' ? { repositoryId: repository.id, includePrivate: false, asOf } : { handle })),
  });
}
function successfulRead(path: string) {
  return path === '/api/scan/start'
    ? response({ node: { ...repository, defaultBranchRef: null } })
    : response({ node: { isPrivate: false, isFork: false, object: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }, rateLimit: { remaining: 4500, resetAt: '2026-01-01T01:00:00Z' } });
}

beforeEach(async () => {
  upstream = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', upstream);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  sessionCookie = `${cookieName(env, 'session')}=${await seal(env, 'session', session(expiresAt))}`;
  expiredCookie = `${cookieName(env, 'session')}=${await seal(env, 'session', session(expiresAt - 7200))}`;
  handle = await sign(env, 'scan-page', { version: 1, purpose: 'scan-page', sessionId: 'session', githubUserId: viewer.id,
    repositoryNodeId: repository.id, headOid: 'a'.repeat(40), isPrivate: false, after: null, asOf, expiresAt });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(['/api/scan/start', '/api/scan/page'])('%s history allowance', path => {
  it('uses the separate user and IP allowance even when discovery and file allowances are exhausted', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true });
    const general = vi.fn().mockResolvedValue({ success: false });
    const files = vi.fn().mockResolvedValue({ success: false });
    upstream.mockResolvedValueOnce(successfulRead(path));
    const result = await worker.fetch(post(path), { ...env, SCAN_LIMITER: { limit: scan }, API_LIMITER: { limit: general }, FILE_LIMITER: { limit: files } });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(scan.mock.calls).toEqual([[{ key: `scan:user:${viewer.id}` }], [{ key: 'scan:ip:192.0.2.10' }]]);
    expect(general).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it.each(['user', 'ip'])('rejects exhausted %s allowance before reading history', async blocked => {
    const scan = vi.fn(async ({ key }: { key: string }) => ({ success: !key.startsWith(`scan:${blocked}:`) }));
    const general = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(post(path), { ...env, SCAN_LIMITER: { limit: scan }, API_LIMITER: { limit: general } });
    expect(result.status).toBe(429); expect(result.headers.get('retry-after')).toBe('60');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 60 } });
    expect(scan).toHaveBeenCalledTimes(blocked === 'user' ? 1 : 2);
    expect(general).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it.each(['missing session', 'expired session', 'foreign origin', 'wrong CSRF'])('checks %s before charging the allowance', async invalid => {
    const headers: Record<string, string> = invalid === 'missing session' ? { Cookie: '' }
      : invalid === 'expired session' ? { Cookie: expiredCookie }
      : invalid === 'foreign origin' ? { Origin: 'https://attacker.example' }
      : { 'x-csrf-token': 'wrong' };
    const scan = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(post(path, headers), { ...env, SCAN_LIMITER: { limit: scan } });
    expect(result.status).toBe(invalid.endsWith('session') ? 401 : 403);
    expect(scan).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it('charges malformed authenticated requests but never reads GitHub', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(post(path, {}, { unexpected: true }), { ...env, SCAN_LIMITER: { limit: scan } });
    expect(result.status).toBe(400); expect(scan).toHaveBeenCalledTimes(2); expect(upstream).not.toHaveBeenCalled();
  });

  it('retains the bounded request body after separating the allowance', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(post(path, {}, { padding: 'x'.repeat(8192) }), { ...env, SCAN_LIMITER: { limit: scan } });
    expect(result.status).toBe(413); expect(scan).toHaveBeenCalledTimes(2); expect(upstream).not.toHaveBeenCalled();
  });

  it('does not make non-POST methods a scan route', async () => {
    const scan = vi.fn().mockResolvedValue({ success: true });
    const general = vi.fn().mockResolvedValue({ success: true });
    const result = await worker.fetch(new Request(`${env.APP_ORIGIN}${path}`, { headers: { Cookie: sessionCookie } }), {
      ...env, SCAN_LIMITER: { limit: scan }, API_LIMITER: { limit: general },
    });
    expect(result.status).toBe(404); expect(scan).not.toHaveBeenCalled(); expect(general).toHaveBeenCalledOnce(); expect(upstream).not.toHaveBeenCalled();
  });
});

it('keeps discovery limited separately even when the scan allowance permits work', async () => {
  const scan = vi.fn().mockResolvedValue({ success: true });
  const general = vi.fn().mockResolvedValue({ success: false });
  const result = await worker.fetch(new Request(`${env.APP_ORIGIN}/api/github/repositories?kind=owned`, { headers: { Cookie: sessionCookie } }), {
    ...env, SCAN_LIMITER: { limit: scan }, API_LIMITER: { limit: general },
  });
  expect(result.status).toBe(429); expect(general).toHaveBeenCalledOnce(); expect(scan).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
});

it('still allows logout with exhausted scan, file, and general allowances', async () => {
  const limit = vi.fn().mockResolvedValue({ success: false });
  upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const result = await worker.fetch(post('/api/auth/logout', {}, {}), {
    ...env, SCAN_LIMITER: { limit }, FILE_LIMITER: { limit }, API_LIMITER: { limit },
  });
  expect(result.status).toBe(200); expect(limit).not.toHaveBeenCalled();
  expect(result.headers.getSetCookie().filter(value => value.includes('Max-Age=0'))).toHaveLength(3);
});
