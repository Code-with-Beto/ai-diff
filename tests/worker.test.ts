import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/index';
import type { ScanPage } from '../shared/types';
import { externalFetch } from '../worker/github';
import { challenge, cookieName, seal, unseal, verify } from '../worker/security';

const env: Env = {
  APP_ORIGIN: 'https://aidiff.example.com', GITHUB_APP_SLUG: 'ai-diff-test', GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'),
  ASSETS: { fetch: async () => new Response('app') },
};
const viewer = { id: 'U_test', login: 'beto', avatarUrl: 'https://avatars.githubusercontent.com/u/1' };
const repository = { id: 'R_test', nameWithOwner: 'beto/project', isPrivate: false, isFork: false, isArchived: false, description: null };
const headOid = 'a'.repeat(40);
let githubFetch: ReturnType<typeof vi.fn<typeof fetch>>;
let sessionCookie: string;
const csrf = 'csrf-test';

const apiResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const request = (path: string, options: RequestInit = {}) => new Request(`${env.APP_ORIGIN}${path}`, options);
const authenticated = (path: string, options: RequestInit = {}) => request(path, { ...options, headers: { Cookie: sessionCookie, ...options.headers } });
const post = (path: string, input: unknown, headers: Record<string, string> = {}) => authenticated(path, { method: 'POST', headers: { Origin: env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });

async function createSession(overrides: Record<string, unknown> = {}) {
  return seal(env, 'session', { version: 1, sessionId: 'session-one', user: viewer, token: 'ghu_test-token', csrfToken: csrf, expiresAt: Math.floor(Date.now() / 1000) + 3600, ...overrides });
}

async function start(overrides: Record<string, unknown> = {}) {
  githubFetch.mockResolvedValueOnce(apiResponse({ data: { node: { ...repository, defaultBranchRef: { target: { oid: headOid } }, ...overrides } } }));
  const response = await worker.fetch(post('/api/scan/start', { repositoryId: repository.id, includePrivate: false, asOf: '2026-01-01T00:00:00.000Z' }), env);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ handle: string | null; empty: boolean }>;
}

beforeEach(async () => {
  githubFetch = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', githubFetch);
  sessionCookie = `${cookieName(env, 'session')}=${await createSession()}`;
});
afterEach(() => vi.unstubAllGlobals());

describe('session and OAuth', () => {
  it('has a truthful unconfigured session without exposing secrets', async () => {
    const response = await worker.fetch(request('/api/session'), { ...env, GITHUB_CLIENT_SECRET: '' });
    expect(await response.json()).toEqual({ configured: false, authenticated: false });
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('returns viewer metadata and CSRF but no GitHub token', async () => {
    const response = await worker.fetch(authenticated('/api/session'), env);
    const body = await response.json();
    expect(body).toMatchObject({ configured: true, authenticated: true, user: viewer, csrfToken: csrf });
    expect(JSON.stringify(body)).not.toContain('ghu_');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an expired session before querying GitHub', async () => {
    sessionCookie = `${cookieName(env, 'session')}=${await createSession({ expiresAt: 1 })}`;
    const response = await worker.fetch(authenticated('/api/github/repositories'), env);
    expect(response.status).toBe(401);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('uses PKCE S256, encrypted OAuth state, and an exact configured redirect', async () => {
    const response = await worker.fetch(request('/api/auth/github/start'), env);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    const encryptedCookie = response.headers.get('set-cookie')!.split(';')[0];
    const encrypted = encryptedCookie.slice(encryptedCookie.indexOf('=') + 1);
    const state = await unseal<{ state: string; verifier: string }>(env, 'oauth', encrypted);
    expect(location.origin).toBe('https://github.com');
    expect(location.searchParams.get('state')).toBe(state.state);
    expect(location.searchParams.get('code_challenge')).toBe(await challenge(state.verifier));
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(`${env.APP_ORIGIN}/api/auth/github/callback`);
    expect(location.searchParams.has('scope')).toBe(false);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(encrypted).not.toContain(state.verifier);
  });

  it('rejects OAuth state mismatch without exchanging a code', async () => {
    const oauth = await seal(env, 'oauth', { state: 'correct', verifier: 'verifier', expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const response = await worker.fetch(request('/api/auth/github/callback?code=one&state=wrong', { headers: { Cookie: `${cookieName(env, 'oauth')}=${oauth}` } }), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${env.APP_ORIGIN}/?auth=expired`);
    expect(githubFetch).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('exchanges with the original verifier and stores no refresh token', async () => {
    const oauth = await seal(env, 'oauth', { state: 'correct', verifier: 'original-verifier', expiresAt: Math.floor(Date.now() / 1000) + 600 });
    githubFetch.mockResolvedValueOnce(apiResponse({ access_token: 'ghu_test-token', refresh_token: 'ghr_never-store-me', expires_in: 28800 }));
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { viewer } }));
    const response = await worker.fetch(request('/api/auth/github/callback?code=one&state=correct', { headers: { Cookie: `${cookieName(env, 'oauth')}=${oauth}` } }), env);
    expect(response.status).toBe(302);
    const exchange = JSON.parse(String(githubFetch.mock.calls[0][1]?.body));
    expect(exchange).toMatchObject({ code_verifier: 'original-verifier', client_secret: env.GITHUB_CLIENT_SECRET });
    expect(new Headers(githubFetch.mock.calls[0][1]?.headers).get('User-Agent')).toBe('Code-with-Beto-AI-Diff');
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((value) => value.startsWith(`${cookieName(env, 'session')}=`))!;
    const value = session.split(';')[0].split('=')[1];
    const decrypted = await unseal<Record<string, unknown>>(env, 'session', value);
    expect(decrypted.token).toBe('ghu_test-token');
    expect(JSON.stringify(decrypted)).not.toContain('ghr_');
    expect(JSON.stringify(decrypted)).not.toContain('client-secret');
  });

  it('revokes on logout and clears local state even when revocation fails', async () => {
    githubFetch.mockResolvedValueOnce(apiResponse({}, 503));
    const response = await worker.fetch(post('/api/auth/logout', {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'revoke_failed' } });
    expect(githubFetch.mock.calls[0][0]).toBe('https://api.github.com/applications/Iv1.test/token');
    expect(githubFetch.mock.calls[0][1]?.method).toBe('DELETE');
    expect(response.headers.getSetCookie().filter((value) => value.includes('Max-Age=0'))).toHaveLength(3);
  });

  it('reports unconfirmed revocation on network failure and still clears local cookies', async () => {
    githubFetch.mockRejectedValueOnce(new Error('sensitive upstream connection detail'));
    const response = await worker.fetch(post('/api/auth/logout', {}), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'revoke_failed' } });
    expect(response.headers.getSetCookie().filter((value) => value.includes('Max-Age=0'))).toHaveLength(3);
  });

  it('redirects an exchange failure safely without reflecting GitHub error text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oauth = await seal(env, 'oauth', { state: 'correct', verifier: 'original-verifier', expiresAt: Math.floor(Date.now() / 1000) + 600 });
    githubFetch.mockResolvedValueOnce(apiResponse({ error: 'bad_verification_code', error_description: 'do not expose this upstream detail' }, 400));
    const response = await worker.fetch(request('/api/auth/github/callback?code=one&state=correct', { headers: { Cookie: `${cookieName(env, 'oauth')}=${oauth}` } }), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${env.APP_ORIGIN}/?auth=failed`);
    expect(response.headers.get('X-AIDiff-Error-Code')).toBe('oauth_code_rejected');
    expect(warn).toHaveBeenCalledExactlyOnceWith('auth_callback_failed', 'oauth_code_rejected');
    expect(await response.text()).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    warn.mockRestore();
  });

  it('does not expose unknown upstream OAuth errors in callback diagnostics', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const oauth = await seal(env, 'oauth', { state: 'correct', verifier: 'original-verifier', expiresAt: Math.floor(Date.now() / 1000) + 600 });
    githubFetch.mockResolvedValueOnce(apiResponse({ error: 'unknown error containing sensitive data', access_token: 'a-secret-token', error_description: 'sensitive body' }, 400));
    const response = await worker.fetch(request('/api/auth/github/callback?code=private-code&state=correct', { headers: { Cookie: `${cookieName(env, 'oauth')}=${oauth}` } }), env);
    expect(response.headers.get('X-AIDiff-Error-Code')).toBe('oauth_failed');
    expect(warn).toHaveBeenCalledExactlyOnceWith('auth_callback_failed', 'oauth_failed');
    expect(response.headers.get('location')).toBe(`${env.APP_ORIGIN}/?auth=failed`);
    warn.mockRestore();
  });
});

describe('request boundaries', () => {
  it('uses workerd-compatible manual redirects and refuses to forward credentials', async () => {
    githubFetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://untrusted.invalid/' } }));
    await expect(externalFetch('https://api.github.com/zen', { headers: { Authorization: 'Bearer test-only' } })).rejects.toMatchObject({ code: 'github_unexpected_redirect' });
    expect(githubFetch).toHaveBeenCalledOnce();
    expect(githubFetch.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('classifies runtime TypeErrors without disclosing their raw message', async () => {
    githubFetch.mockRejectedValueOnce(new TypeError('sensitive runtime details'));
    await expect(externalFetch('https://api.github.com/zen', {})).rejects.toMatchObject({ code: 'github_fetch_type_error', message: 'The GitHub request could not be started. Please try again.' });
  });
  it.each([
    { Origin: 'https://evil.example', 'x-csrf-token': csrf },
    { Origin: env.APP_ORIGIN, 'x-csrf-token': 'wrong' },
  ])('rejects a foreign origin or bad CSRF without logout side effects', async (headers) => {
    const response = await worker.fetch(post('/api/auth/logout', {}, headers), env);
    expect(response.status).toBe(403);
    expect(githubFetch).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects non-GitHub URLs before making any outbound call', async () => {
    const response = await worker.fetch(post('/api/github/repository', { url: 'https://github.com.evil.example/owner/repo' }), env);
    expect(response.status).toBe(400);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('requires explicit private consent despite valid GitHub authorization', async () => {
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { node: { ...repository, isPrivate: true, defaultBranchRef: { target: { oid: headOid } } } } }));
    const response = await worker.fetch(post('/api/scan/start', { repositoryId: repository.id, includePrivate: false, asOf: '2026-01-01T00:00:00Z' }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'private_consent_required' } });
  });

  it('does not treat setup installation identifiers as authorization', async () => {
    const response = await worker.fetch(authenticated('/api/github/setup?installation_id=123&state=forged'), env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${env.APP_ORIGIN}/?auth=installation_failed`);
    expect(githubFetch).not.toHaveBeenCalled();
  });
});

describe('repository pagination', () => {
  it('returns public GraphQL cursors instead of silently stopping at 100', async () => {
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { viewer: { repositories: { nodes: [repository], pageInfo: { hasNextPage: true, endCursor: 'next-public' } } } } }));
    const response = await worker.fetch(authenticated('/api/github/repositories?kind=owned&cursor=current'), env);
    expect(await response.json()).toEqual({ repositories: [repository], hasNextPage: true, cursor: 'next-public' });
    const query = JSON.parse(String(githubFetch.mock.calls[0][1]?.body));
    expect(query.variables.after).toBe('current');
    expect(query.query).toContain('privacy: PUBLIC');
  });

  it('uses user-installation repository access, follows REST pagination, and normalizes fields', async () => {
    githubFetch.mockResolvedValueOnce(apiResponse({ repositories: [{ node_id: repository.id, full_name: repository.nameWithOwner, private: true, fork: false, archived: true, description: null }] }, 200, { link: '<https://api.github.com/user/installations/42/repositories?page=3>; rel="next"' }));
    const response = await worker.fetch(authenticated('/api/github/repositories?kind=installation&installationId=42&cursor=2'), env);
    expect(githubFetch.mock.calls[0][0]).toBe('https://api.github.com/user/installations/42/repositories?per_page=100&page=2');
    expect(await response.json()).toEqual({ repositories: [{ ...repository, isPrivate: true, isArchived: true }], hasNextPage: true, cursor: '3' });
  });
});

describe('signed scan pages', () => {
  it('freezes HEAD and scan time and signs the next GitHub cursor', async () => {
    const { handle } = await start();
    const first = await verify<Record<string, unknown>>(env, 'scan-page', handle!);
    expect(first).toMatchObject({ repositoryNodeId: repository.id, headOid, githubUserId: viewer.id, after: null, asOf: '2026-01-01T00:00:00.000Z' });
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { node: { isPrivate: false, object: { history: { nodes: [{ oid: 'b'.repeat(40), additions: 123, deletions: 12, committedDate: '2025-12-31T23:59:59Z', author: { user: { id: viewer.id } }, parents: { totalCount: 1 } }], pageInfo: { hasNextPage: true, endCursor: 'github-next' } } } }, rateLimit: { remaining: 4500, resetAt: '2026-01-01T01:00:00Z' } } }));
    const response = await worker.fetch(post('/api/scan/page', { handle, author: 'another-user', cursor: 'attacker-cursor' }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as ScanPage;
    expect(body.commits).toEqual([{ oid: 'b'.repeat(40), additions: 123, deletions: 12, committedDate: '2025-12-31T23:59:59Z', authorId: viewer.id, parentCount: 1 }]);
    const next = await verify<Record<string, unknown>>(env, 'scan-page', body.nextHandle!);
    expect(next).toMatchObject({ headOid, after: 'github-next', asOf: first.asOf });
    const query = JSON.parse(String(githubFetch.mock.calls[1][1]?.body));
    expect(query.variables).toMatchObject({ head: headOid, author: viewer.id, after: null, until: first.asOf });
  });

  it('rejects altered handles before querying GitHub', async () => {
    const { handle } = await start();
    githubFetch.mockClear();
    const altered = `${handle!.startsWith('a') ? 'b' : 'a'}${handle!.slice(1)}`;
    const response = await worker.fetch(post('/api/scan/page', { handle: altered }), env);
    expect(response.status).toBe(400);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('rejects a valid handle reused from another signed-in session', async () => {
    const { handle } = await start();
    githubFetch.mockClear();
    sessionCookie = `${cookieName(env, 'session')}=${await createSession({ sessionId: 'new-session' })}`;
    const response = await worker.fetch(post('/api/scan/page', { handle }), env);
    expect(response.status).toBe(400);
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('handles an empty repository explicitly', async () => {
    expect(await start({ defaultBranchRef: null })).toEqual({ handle: null, repository, empty: true });
  });

  it('rejects a formerly public repository that becomes private mid-scan', async () => {
    const { handle } = await start();
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { node: { isPrivate: true, object: { history: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }, rateLimit: { remaining: 4500, resetAt: '2026-01-01T01:00:00Z' } } }));
    const response = await worker.fetch(post('/api/scan/page', { handle }), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'repository_visibility_changed' } });
  });

  it('refuses partial GraphQL data instead of returning understated results', async () => {
    const { handle } = await start();
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { node: null }, errors: [{ type: 'INTERNAL', message: 'private sensitive failure detail' }] }));
    const response = await worker.fetch(post('/api/scan/page', { handle }), env);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('github_incomplete');
    expect(text).not.toContain('private sensitive');
  });

  it('preserves rate-limit retry guidance', async () => {
    const { handle } = await start();
    githubFetch.mockResolvedValueOnce(apiResponse({ message: 'rate limit exceeded' }, 403, { 'retry-after': '120' }));
    const response = await worker.fetch(post('/api/scan/page', { handle }), env);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 120 } });
  });
});

describe('Worker rate limits', () => {
  it('limits OAuth starts by Cloudflare client IP without creating authorization state', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const response = await worker.fetch(request('/api/auth/github/start', { headers: { 'CF-Connecting-IP': '192.0.2.10' } }), { ...env, AUTH_LIMITER: limiter });
    expect(limiter.limit).toHaveBeenCalledWith({ key: 'auth:192.0.2.10' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${env.APP_ORIGIN}/?auth=rate_limited`);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('limits authenticated API work by stable user ID before GitHub access', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const response = await worker.fetch(authenticated('/api/github/repositories?kind=owned'), { ...env, API_LIMITER: limiter });
    expect(limiter.limit).toHaveBeenCalledWith({ key: `user:${viewer.id}` });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', retryAfter: 60 } });
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it('allows authenticated work when its limiter permits the request', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
    githubFetch.mockResolvedValueOnce(apiResponse({ data: { viewer: { repositories: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }));
    const response = await worker.fetch(authenticated('/api/github/repositories?kind=owned'), { ...env, API_LIMITER: limiter });
    expect(response.status).toBe(200);
    expect(limiter.limit).toHaveBeenCalledOnce();
  });

  it('allows logout even after the API limit has been reached', async () => {
    const limiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    githubFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const response = await worker.fetch(post('/api/auth/logout', {}), { ...env, API_LIMITER: limiter });
    expect(response.status).toBe(200);
    expect(limiter.limit).not.toHaveBeenCalled();
    expect(response.headers.getSetCookie().filter((value) => value.includes('Max-Age=0'))).toHaveLength(3);
  });
});
