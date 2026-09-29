import { afterEach, describe, expect, it, vi } from 'vitest';
import preset from '../public/share-sample.json';
import type { ShareResult } from '../shared/types';
import { publishShare, sampleShare } from '../src/lib/published-share';

const sample = preset as ShareResult;
const real = { ...sample, sample: false, login: 'test-dev' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

function setup() {
  vi.stubGlobal('window', { location: { origin: 'https://aidiff.example' } });
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('publishing share images', () => {
  it('uses a preset short link only for an exact matching sample without network reads or writes', async () => {
    const fetch = setup();
    const result = await publishShare(sample, new Blob([], { type: 'image/png' }), 'light', new AbortController().signal);
    expect(result.url).toBe('https://aidiff.example/s/sample-light');
    expect(result.imageUrl).toBe(`${result.url}/image.png`);
    expect(fetch).not.toHaveBeenCalled();
    expect(sampleShare({ ...sample, before: { ...sample.before, additions: 0 } }, 'dark', 'https://aidiff.example')).toBeNull();
  });

  it('does not publish another person’s result or an expired connection', async () => {
    const fetch = setup();
    for (const session of [{ authenticated: false }, { authenticated: true, csrfToken: 'test', user: { login: 'someone-else' } }]) {
      fetch.mockResolvedValueOnce(json(session));
      await expect(publishShare(real, new Blob(['png'], { type: 'image/png' }), 'dark', new AbortController().signal)).rejects.toThrow();
    }
    expect(fetch.mock.calls.every(([path]) => path === '/api/session')).toBe(true);
  });

  it('sends the selected PNG, aggregate result and explicit consent with the current CSRF token', async () => {
    const fetch = setup();
    fetch.mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'fresh-csrf', user: { login: 'TEST-DEV' } }));
    fetch.mockResolvedValueOnce(json({ url: 'https://aidiff.example/s/abcdefghijklmnop', imageUrl: 'https://aidiff.example/s/abcdefghijklmnop/image.png', imageTheme: 'dark' }));
    await publishShare(real, new Blob(['exact PNG bytes'], { type: 'image/png' }), 'dark', new AbortController().signal);
    const [path, options] = fetch.mock.calls[1];
    expect(path).toBe('/api/share');
    expect(options?.headers).toMatchObject({ 'x-csrf-token': 'fresh-csrf' });
    expect(JSON.parse(options?.body as string)).toEqual({ result: real, imageTheme: 'dark', image: btoa('exact PNG bytes'), publishConsent: true });
  });

  it('rejects canceled publishing and oversized images before upload', async () => {
    const fetch = setup();
    const controller = new AbortController(); controller.abort();
    await expect(publishShare(real, new Blob(), 'dark', controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(json({ authenticated: true, csrfToken: 'fresh-csrf', user: { login: 'test-dev' } }));
    await expect(publishShare(real, new Blob([new Uint8Array(192 * 1024 + 1)], { type: 'image/png' }), 'dark', new AbortController().signal)).rejects.toThrow('too large');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
