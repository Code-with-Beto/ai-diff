import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import worker, { type Env } from '../worker/index';
import { cookieName, seal } from '../worker/security';
import { SHARE_BODY_LIMIT, SHARE_IMAGE_LIMIT } from '../worker/sharing';
import { decodeShare } from '../src/lib/share';
import type { ShareResult } from '../shared/types';

const result: ShareResult = {
  version: 1, login: 'octo-dev', cutoff: '2025-09-29', asOf: '2026-09-29T12:00:00.000Z', firstCommitAt: '2019-01-01T00:00:00.000Z',
  before: { additions: 20000, deletions: 2000, commits: 100 }, after: { additions: 60000, deletions: 15000, commits: 200 },
  coverage: { completed: 3, unavailable: 1, incomplete: 2, total: 6 }, includesPrivate: true, sample: false,
};
const sample: ShareResult = { ...result, login: 'sample-dev', sample: true };
const word = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
const chunk = (name: string, data: Buffer) => {
  const content = Buffer.concat([Buffer.from(name), data]);
  return Buffer.concat([word(data.length), content, word(crc32(content))]);
};
const makePng = (width = 1200, height = 600, extra: Buffer[] = []) => {
  const header = Buffer.concat([word(width), word(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(Buffer.alloc((1200 * 4 + 1) * 600))), chunk('IEND', Buffer.alloc(0))]);
};
const png = makePng();
const indexHtml = '<!doctype html><html><head><meta charset="utf-8"><title>OLD TITLE</title><meta name="description" content="OLD DESCRIPTION"><meta property="og:image" content="OLD IMAGE"><meta property=\'og:title\' content=\'OLD OG\'><meta name=twitter:card content=summary><meta name="ai-diff-result" content="OLD RESULT"><script src="/theme.js"></script></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';
let env: Env;
let sessionCookie: string;
let records: Map<string, ArrayBuffer>;
let kvGet: ReturnType<typeof vi.fn<NonNullable<Env['SHARE_RESULTS']>['get']>>;
let kvPut: ReturnType<typeof vi.fn<NonNullable<Env['SHARE_RESULTS']>['put']>>;
let assets: ReturnType<typeof vi.fn<Env['ASSETS']['fetch']>>;
const csrf = 'share-csrf';
const viewer = { id: 'U_share', login: 'octo-dev', avatarUrl: 'https://avatars.githubusercontent.com/u/1' };
const upload = (overrides: Record<string, unknown> = {}) => ({ result, imageTheme: 'dark', image: png.toString('base64'), publishConsent: true, ...overrides });
const post = (body: unknown, headers: Record<string, string> = {}) => new Request(`${env.APP_ORIGIN}/api/share`, { method: 'POST', headers: { Cookie: sessionCookie, Origin: env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers }, body: JSON.stringify(body) });
const publicRequest = (path: string, method = 'GET') => new Request(`https://untrusted-host.example${path}`, { method });
const meta = (html: string, name: string) => html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)">`))?.[1];
async function publish(imageTheme: 'light' | 'dark' = 'dark') {
  const response = await worker.fetch(post(upload({ imageTheme })), env);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ url: string; imageUrl: string; imageTheme: string }>;
}

beforeEach(async () => {
  records = new Map();
  kvGet = vi.fn<NonNullable<Env['SHARE_RESULTS']>['get']>(async (key: string) => records.get(key)?.slice(0) ?? null);
  kvPut = vi.fn<NonNullable<Env['SHARE_RESULTS']>['put']>(async (key: string, value: ArrayBuffer | ArrayBufferView) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    records.set(key, Uint8Array.from(bytes).buffer);
  });
  assets = vi.fn<Env['ASSETS']['fetch']>(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(indexHtml, { headers: { 'Content-Type': 'text/html' } });
    if (path === '/share-sample.json') return Response.json(sample);
    if (/^\/share-sample-(light|dark)\.png$/.test(path)) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    return new Response('missing', { status: 404 });
  });
  env = {
    APP_ORIGIN: 'https://aidiff.example.com', SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'),
    GITHUB_APP_SLUG: 'share-test', GITHUB_CLIENT_ID: 'Iv1.test', GITHUB_CLIENT_SECRET: 'test-secret',
    ASSETS: { fetch: assets }, SHARE_RESULTS: { get: kvGet, put: kvPut },
    SHARE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
  const session = await seal(env, 'session', { version: 1, sessionId: 'share-session', user: viewer, token: 'ghu_test-never-persist', csrfToken: csrf, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
  sessionCookie = `${cookieName(env, 'session')}=${session}`;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external fetch')));
});
afterEach(() => vi.unstubAllGlobals());

describe('authenticated aggregate and PNG publishing', () => {
  it.each([
    { Cookie: '' },
    { Origin: 'https://other.example' },
    { 'x-csrf-token': 'wrong' },
  ] as Record<string, string>[])('rejects missing authentication or failed CSRF before storage (%j)', async headers => {
    const response = await worker.fetch(post(upload(), headers), env);
    expect(response.status).toBe(headers.Cookie === '' ? 401 : 403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(kvPut).not.toHaveBeenCalled();
    expect(kvGet).not.toHaveBeenCalled();
  });

  it('requires explicit publishing consent even when private totals were already analyzed', async () => {
    const response = await worker.fetch(post(upload({ publishConsent: false })), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'share_consent_required' } });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it.each([
    { ...result, login: 'someone-else' },
    { ...result, sample: true },
  ])('prevents impersonation and arbitrary sample uploads', async snapshot => {
    const response = await worker.fetch(post(upload({ result: snapshot })), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'share_owner_required' } });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive matching login and writes one binary record without pre-reading or storing credentials', async () => {
    const response = await worker.fetch(post(upload({ result: { ...result, login: 'Octo-Dev' } })), env);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const published = await response.json() as { url: string; imageUrl: string; imageTheme: string };
    expect(published.url).toMatch(/^https:\/\/aidiff\.example\.com\/s\/[A-Za-z0-9_-]{16}$/);
    expect(published.imageUrl).toBe(`${published.url}/image.png`);
    expect(published.imageTheme).toBe('dark');
    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(kvGet).not.toHaveBeenCalled();
    const stored = [...records.values()][0];
    const length = new DataView(stored).getUint32(0);
    const headerText = new TextDecoder().decode(new Uint8Array(stored, 4, length));
    const header = JSON.parse(headerText);
    expect(Object.keys(header).sort()).toEqual(['createdAt', 'imageTheme', 'result']);
    expect(header.result.login).toBe('Octo-Dev');
    expect(header.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(headerText).not.toMatch(/ghu_|csrf|sessionId|token|repositoryName/);
    expect(Buffer.from(stored.slice(4 + length))).toEqual(png);
    expect(env.SHARE_LIMITER!.limit).toHaveBeenNthCalledWith(1, { key: 'share:user:U_share' });
    expect(env.SHARE_LIMITER!.limit).toHaveBeenNthCalledWith(2, { key: 'share:ip:192.0.2.1' });
  });

  it.each([
    upload({ extra: true }), upload({ imageTheme: 'automatic' }), upload({ result: { ...result, repository: 'private/name' } }),
    upload({ result: { ...result, before: { ...result.before, additions: -1 } } }), upload({ result: { ...result, coverage: { ...result.coverage, total: 99 } } }),
    { result, imageTheme: 'light', image: png.toString('base64') },
  ])('rejects malformed or extra aggregate/upload fields %#', async input => {
    const response = await worker.fetch(post(input), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_share' } });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('bounds the streaming upload even with a false content length, retaining the original 8KiB API limit', async () => {
    const oversized = await worker.fetch(post(upload({ image: 'A'.repeat(SHARE_BODY_LIMIT) }), { 'Content-Length': '1' }), env);
    expect(oversized.status).toBe(413);
    const ordinary = new Request(`${env.APP_ORIGIN}/api/scan/start`, { method: 'POST', headers: { Cookie: sessionCookie, Origin: env.APP_ORIGIN, 'x-csrf-token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'A'.repeat(8192) }) });
    expect((await worker.fetch(ordinary, env)).status).toBe(413);
    expect(kvPut).not.toHaveBeenCalled();
  });

  it.each([
    ['not PNG', Buffer.from('<svg onload="alert(1)"></svg>')],
    ['wrong dimensions', makePng(1, 1)],
    ['truncated chunk', png.subarray(0, png.length - 1)],
    ['trailing content', Buffer.concat([png, Buffer.from('<html>')])],
    ['invalid checksum', Buffer.from(png.map((byte: number, index: number) => index === 50 ? byte ^ 1 : byte))],
    ['unknown critical chunk', makePng(1200, 600, [chunk('ABCD', Buffer.from('x'))])],
    ['oversized PNG', makePng(1200, 600, [chunk('tEXt', Buffer.alloc(SHARE_IMAGE_LIMIT))])],
  ])('rejects %s', async (_name, image) => {
    const response = await worker.fetch(post(upload({ image: image.toString('base64') })), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_share_image' } });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it.each(['data:image/png;base64,', '%%%%', png.toString('base64') + '\n'])('rejects noncanonical base64 input %#', async image => {
    expect((await worker.fetch(post(upload({ image })), env)).status).toBe(400);
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('bounds PNG chunk processing even when many tiny valid chunks fit the byte limit', async () => {
    const ancillary = chunk('tEXt', Buffer.from('x'));
    const manyChunks = makePng(1200, 600, Array.from({ length: 256 }, () => ancillary));
    expect(manyChunks.byteLength).toBeLessThan(SHARE_IMAGE_LIMIT);
    const response = await worker.fetch(post(upload({ image: manyChunks.toString('base64') })), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_share_image' } });
    expect(kvPut).not.toHaveBeenCalled();
  });

  it.each([1, 2])('applies the publishing limiter before reading or writing storage (limiter call %i)', async blockedCall => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    if (blockedCall === 1) limit.mockResolvedValueOnce({ success: false });
    else limit.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const response = await worker.fetch(post(upload()), { ...env, SHARE_LIMITER: { limit } });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('reports missing storage or exhausted write quota without returning a dead link', async () => {
    const unavailable = await worker.fetch(post(upload()), { ...env, SHARE_RESULTS: undefined });
    expect(unavailable.status).toBe(503);
    kvPut.mockRejectedValueOnce(new Error('internal quota details'));
    const exhausted = await worker.fetch(post(upload()), env);
    expect(exhausted.status).toBe(503);
    expect(exhausted.headers.get('cache-control')).toBe('no-store');
    const body = await exhausted.json();
    expect(body).toMatchObject({ error: { code: 'sharing_unavailable' } });
    expect(JSON.stringify(body)).not.toMatch(/internal quota|imageUrl|ghu_/);
  });
});

describe('public share pages and PNG previews', () => {
  it.each(['light', 'dark'] as const)('serves real %s metadata and the same PNG, with public GET/HEAD and configured canonical origin', async theme => {
    const published = await publish(theme);
    const path = new URL(published.url).pathname;
    const response = await worker.fetch(publicRequest(path), env);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html).not.toMatch(/OLD TITLE|OLD DESCRIPTION|OLD IMAGE|OLD OG|OLD RESULT|untrusted-host/);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/property="og:image"/g)).toHaveLength(1);
    expect(meta(html, 'og:url')).toBe(published.url);
    expect(meta(html, 'og:image')).toBe(published.imageUrl);
    expect(meta(html, 'og:image:width')).toBe('1200');
    expect(meta(html, 'og:image:height')).toBe('600');
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(meta(html, 'og:description')).toContain('Partial results: 3/6');
    expect(meta(html, 'og:description')).toContain('Includes private totals.');
    expect(meta(html, 'og:description')).toContain('Self-reported');
    expect(meta(html, 'ai-diff-image-theme')).toBe(theme);
    expect(decodeShare(meta(html, 'ai-diff-result')!)).toEqual(result);
    expect(html).toContain('<script type="module" src="/assets/app.js"></script>');
    const pageHead = await worker.fetch(publicRequest(path, 'HEAD'), env);
    expect(pageHead.status).toBe(200);
    expect(await pageHead.text()).toBe('');
    expect(pageHead.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
    const image = await worker.fetch(publicRequest(`${path}/image.png`), env);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    const imageHead = await worker.fetch(publicRequest(`${path}/image.png`, 'HEAD'), env);
    expect(imageHead.status).toBe(200);
    expect(imageHead.headers.get('content-length')).toBe(String(png.byteLength));
    expect(await imageHead.text()).toBe('');
    expect(kvPut).toHaveBeenCalledTimes(1);
  });

  it.each(['/s/unknown', '/s/../../secrets', '/s/AAAAAAAAAAAAAAAA/edit', '/s/sample-red', '/s/AAAAAAAAAAAAAAAA'])('never falls through missing shares to the SPA or caches misses (%s)', async path => {
    const response = await worker.fetch(publicRequest(path.replace('/../../', '/%2e%2e%2f%2e%2e/')), env);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('Shared result unavailable');
    expect(assets).not.toHaveBeenCalled();
  });

  it('does not allow writes on public page/image routes', async () => {
    for (const path of ['/s/AAAAAAAAAAAAAAAA', '/s/AAAAAAAAAAAAAAAA/image.png']) {
      const response = await worker.fetch(publicRequest(path, 'POST'), env);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(kvGet).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();
  });

  it('fails closed for read quota errors, corrupted records and unavailable storage', async () => {
    kvGet.mockRejectedValueOnce(new Error('private diagnostic'));
    const failed = await worker.fetch(publicRequest('/s/AAAAAAAAAAAAAAAA'), env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private diagnostic');
    records.set('share:AAAAAAAAAAAAAAAA', new Uint8Array([0, 0, 0, 255]).buffer);
    const corrupt = await worker.fetch(publicRequest('/s/AAAAAAAAAAAAAAAA'), env);
    expect(corrupt.status).toBe(503);
    expect(corrupt.headers.get('cache-control')).toBe('no-store');
    const missingBinding = await worker.fetch(publicRequest('/s/AAAAAAAAAAAAAAAA'), { ...env, SHARE_RESULTS: undefined });
    expect(missingBinding.status).toBe(503);
  });

  it.each(['light', 'dark'] as const)('serves fixed %s sample routes without OAuth configuration, KV or anonymous publishing', async theme => {
    const local = { ...env, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', GITHUB_APP_SLUG: '', SHARE_RESULTS: undefined };
    const response = await worker.fetch(publicRequest(`/s/sample-${theme}`), local);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(meta(html, 'ai-diff-image-theme')).toBe(theme);
    expect(meta(html, 'og:description')).toContain('Fictional sample data');
    expect(decodeShare(meta(html, 'ai-diff-result')!)).toEqual(sample);
    expect(meta(html, 'og:image')).toBe(`${env.APP_ORIGIN}/s/sample-${theme}/image.png`);
    const image = await worker.fetch(publicRequest(`/s/sample-${theme}/image.png`), local);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    expect(kvGet).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();
    expect(assets.mock.calls.map(call => new URL(call[0].url).pathname)).toContain(`/share-sample-${theme}.png`);
    const anonymous = new Request(`${env.APP_ORIGIN}/api/share`, { method: 'POST', headers: { Origin: env.APP_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(upload({ result: sample })) });
    expect((await worker.fetch(anonymous, env)).status).toBe(401);
  });
});

describe('positive public edge caching', () => {
  function cacheHarness() {
    const responses = new Map<string, Response>();
    const pending: Promise<unknown>[] = [];
    const match = vi.fn(async (request: Request) => responses.get(request.url)?.clone());
    const put = vi.fn(async (request: Request, response: Response) => { responses.set(request.url, new Response(await response.arrayBuffer(), response)); });
    vi.stubGlobal('caches', { default: { match, put } });
    return { match, put, pending, context: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } };
  }

  it.each(['', '/image.png'])('normalizes public keys and fills a cold HEAD from a complete GET response (%s)', async suffix => {
    const published = await publish();
    const path = `${new URL(published.url).pathname}${suffix}`;
    const cached = cacheHarness();
    const first = new Request(`https://untrusted-host.example${path}?utm_source=one`, { method: 'HEAD', headers: { Cookie: 'unrelated=first', Authorization: 'unrelated' } });
    const head = await worker.fetch(first, env, cached.context);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    await Promise.all(cached.pending);
    expect(cached.put).toHaveBeenCalledTimes(1);
    const key = cached.put.mock.calls[0][0];
    expect(key.url).toBe(`${env.APP_ORIGIN}${path}`);
    expect(key.method).toBe('GET');
    expect([...key.headers]).toEqual([]);
    expect(kvGet).toHaveBeenCalledTimes(1);
    const next = new Request(`https://different-host.example${path}?utm_source=two`, { headers: { Cookie: 'unrelated=second' } });
    const get = await worker.fetch(next, env, cached.context);
    expect(get.status).toBe(200);
    expect(get.headers.get('set-cookie')).toBeNull();
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    if (suffix) expect(Buffer.from(await get.arrayBuffer())).toEqual(png);
    else expect(await get.text()).toContain('ai-diff-result');
    expect(kvGet).toHaveBeenCalledTimes(1);
    const repeatedHead = await worker.fetch(new Request(`${env.APP_ORIGIN}${path}?another=query`, { method: 'HEAD' }), env, cached.context);
    expect(await repeatedHead.text()).toBe('');
    expect(kvGet).toHaveBeenCalledTimes(1);
    expect(cached.put).toHaveBeenCalledTimes(1);
  });

  it('never caches negative lookups, storage errors or unsupported methods', async () => {
    const cached = cacheHarness();
    expect((await worker.fetch(publicRequest('/s/AAAAAAAAAAAAAAAA'), env, cached.context)).status).toBe(404);
    kvGet.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await worker.fetch(publicRequest('/s/BBBBBBBBBBBBBBBB'), env, cached.context)).status).toBe(503);
    expect((await worker.fetch(publicRequest('/s/CCCCCCCCCCCCCCCC', 'POST'), env, cached.context)).status).toBe(405);
    expect(cached.put).not.toHaveBeenCalled();
    expect(cached.pending).toHaveLength(0);
  });

  it.each(['match', 'put'] as const)('keeps valid shares available after a cache %s failure', async failure => {
    const published = await publish();
    const cached = cacheHarness();
    cached[failure].mockRejectedValueOnce(new Error('cache unavailable'));
    const response = await worker.fetch(publicRequest(new URL(published.url).pathname), env, cached.context);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('ai-diff-result');
    await expect(Promise.all(cached.pending)).resolves.toBeDefined();
  });
});
