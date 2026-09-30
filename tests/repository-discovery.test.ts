import { describe, expect, it, vi } from 'vitest';
import type { InstallationsPage, Repository, RepositoryPage } from '../shared/types';
import { ApiError } from '../src/api';
import { discoverPrivateRepositories, discoverPublicRepositories, type DiscoveryContext } from '../src/lib/repository-discovery';

const owned = '/api/github/repositories?kind=owned';
const contributed = '/api/github/repositories?kind=contributed';
const installations = (page = 1) => `/api/github/installations?page=${page}`;
const installed = (id: number, cursor?: string) => `/api/github/repositories?kind=installation&installationId=${id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
const repository = (id: string, overrides: Partial<Repository> = {}): Repository => ({ id, nameWithOwner: `fixture/${id}`, isPrivate: false, isFork: false, isArchived: false, description: null, ...overrides });
const repositories = (items: Repository[] = [], cursor: string | null = null): RepositoryPage => ({ repositories: items, hasNextPage: cursor !== null, cursor });
const installationPage = (ids: number[], nextPage: number | null = null): InstallationsPage => ({ installations: ids.map(id => ({ id, login: `account-${id}` })), nextPage });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(responses: Record<string, unknown>) {
  const controller = new AbortController();
  const onRepositories = vi.fn<(items: Repository[]) => void>();
  const request = vi.fn(async (path: string, signal: AbortSignal): Promise<unknown> => {
    expect(signal).toBe(controller.signal);
    if (!(path in responses)) throw new Error(`Unexpected endpoint: ${path}`);
    const response = await responses[path];
    if (response instanceof Error) throw response;
    return response;
  });
  const context: DiscoveryContext = { request: async <T>(path: string, signal: AbortSignal): Promise<T> => await request(path, signal) as T, signal: controller.signal, onRepositories };
  return { context, controller, request, onRepositories };
}

describe('public repository discovery', () => {
  it('streams a fast source before the slow one completes, with at most two requests in flight', async () => {
    const slow = deferred<RepositoryPage>();
    const firstPublished = deferred<void>();
    const data = fixture({ [owned]: slow.promise, [contributed]: repositories([repository('contribution')], 'page 2'), [`${contributed}&cursor=page%202`]: repositories([repository('other')]) });
    let active = 0, peak = 0, finished = false;
    const baseRequest = data.context.request;
    data.context.request = async <T>(path: string, signal: AbortSignal): Promise<T> => {
      active++; peak = Math.max(active, peak);
      try { return await baseRequest<T>(path, signal); }
      finally { active--; }
    };
    data.onRepositories.mockImplementation(() => firstPublished.resolve());
    const pending = discoverPublicRepositories(data.context).then(result => { finished = true; return result; });
    await firstPublished.promise;
    expect(finished).toBe(false);
    expect(data.onRepositories).toHaveBeenCalledWith([repository('contribution')]);
    expect(data.request.mock.calls.map(([path]) => path)).toContain(owned);
    slow.resolve(repositories([repository('owned')]));
    expect(await pending).toEqual({ errors: [] });
    expect(peak).toBe(2);
    expect(data.onRepositories.mock.calls.flatMap(([items]) => items.map(item => item.id))).toEqual(expect.arrayContaining(['owned', 'contribution', 'other']));
  });

  it('retains the other source and earlier pages when one source fails', async () => {
    const failure = new Error('Could not read contributed repositories');
    const data = fixture({ [owned]: repositories([repository('owned')]), [contributed]: repositories([repository('retained')], 'next'), [`${contributed}&cursor=next`]: failure });
    expect(await discoverPublicRepositories(data.context)).toEqual({ errors: [{ source: 'contributed', error: failure }] });
    expect(data.onRepositories.mock.calls.flatMap(([items]) => items.map(item => item.id))).toEqual(expect.arrayContaining(['owned', 'retained']));
  });

  it('continues through empty and fork-only pages, excludes private repositories, and keeps archived repositories', async () => {
    const archived = repository('archived', { isArchived: true });
    const data = fixture({
      [owned]: repositories([], 'one'),
      [`${owned}&cursor=one`]: repositories([repository('fork', { isFork: true }), repository('private', { isPrivate: true })], 'two'),
      [`${owned}&cursor=two`]: repositories([archived]), [contributed]: repositories(),
    });
    expect(await discoverPublicRepositories(data.context)).toEqual({ errors: [] });
    expect(data.onRepositories.mock.calls.flatMap(([items]) => items)).toEqual([archived]);
    expect(data.request).toHaveBeenCalledTimes(4);
  });

  it.each([null, '', 'next'])('reports missing or repeated next cursor %s without looping', async badCursor => {
    const data = fixture({ [owned]: repositories([repository('first')], 'next'), [`${owned}&cursor=next`]: { ...repositories([repository('second')]), hasNextPage: true, cursor: badCursor }, [contributed]: repositories() });
    const result = await discoverPublicRepositories(data.context);
    expect(result.errors).toMatchObject([{ source: 'owned', error: { code: 'github_incomplete' } }]);
    expect(data.request).toHaveBeenCalledTimes(3);
    expect(data.onRepositories.mock.calls.flatMap(([items]) => items.map(item => item.id))).toEqual(['first', 'second']);
  });

  it('blocks late callbacks and further pages when an aborted transport still resolves', async () => {
    const late = deferred<RepositoryPage>();
    const data = fixture({ [owned]: late.promise, [contributed]: late.promise });
    const pending = discoverPublicRepositories(data.context);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    data.controller.abort();
    late.resolve(repositories([repository('stale')], 'never-requested'));
    await rejected;
    expect(data.onRepositories).not.toHaveBeenCalled();
    expect(data.request).toHaveBeenCalledTimes(2);
  });

  it('does not start requests if already canceled', async () => {
    const data = fixture({}); data.controller.abort();
    await expect(discoverPublicRepositories(data.context)).rejects.toMatchObject({ name: 'AbortError' });
    expect(data.request).not.toHaveBeenCalled();
  });
});

describe('private repository discovery', () => {
  it('streams only installation endpoints, sequentially pages every installation, and deduplicates installation IDs', async () => {
    const data = fixture({
      [installations()]: installationPage([42], 2),
      [installed(42)]: repositories([repository('public-installed')], '2'),
      [installed(42, '2')]: repositories([repository('private-installed', { isPrivate: true }), repository('fork', { isFork: true })]),
      [installations(2)]: installationPage([42, 43]),
      [installed(43)]: repositories([repository('org-private', { isPrivate: true })]),
    });
    expect(await discoverPrivateRepositories(data.context)).toEqual({ installations: 2, errors: [] });
    expect(data.request.mock.calls.map(([path]) => path)).toEqual([installations(), installed(42), installed(42, '2'), installations(2), installed(43)]);
    expect(data.onRepositories.mock.calls.flatMap(([items]) => items.map(item => item.id))).toEqual(['public-installed', 'private-installed', 'org-private']);
  });

  it('keeps reading an accessible organization when another installation is forbidden', async () => {
    const denied = new ApiError({ code: 'repository_unavailable', message: 'Access denied.' });
    const data = fixture({ [installations()]: installationPage([42, 43]), [installed(42)]: denied, [installed(43)]: repositories([repository('accessible', { isPrivate: true })]) });
    expect(await discoverPrivateRepositories(data.context)).toEqual({ installations: 2, errors: [{ source: 'private', error: denied }] });
    expect(data.onRepositories).toHaveBeenCalledWith([repository('accessible', { isPrivate: true })]);
  });

  it.each(['session_expired', 'authentication_required', 'rate_limited'])('stops all installation reads for %s', async code => {
    const failure = new ApiError({ code, message: 'Please retry.' });
    const data = fixture({ [installations()]: installationPage([42, 43]), [installed(42)]: failure });
    await expect(discoverPrivateRepositories(data.context)).rejects.toBe(failure);
    expect(data.request.mock.calls.map(([path]) => path)).toEqual([installations(), installed(42)]);
  });

  it('does not request any repository when no installation is available', async () => {
    const data = fixture({ [installations()]: installationPage([]) });
    expect(await discoverPrivateRepositories(data.context)).toEqual({ installations: 0, errors: [] });
    expect(data.request).toHaveBeenCalledTimes(1);
    expect(data.onRepositories).not.toHaveBeenCalled();
  });

  it.each([0, 1, -1, 1.5, undefined, '2'])('rejects repeated or invalid installation nextPage %s', async nextPage => {
    const data = fixture({ [installations()]: { installations: [], nextPage } });
    await expect(discoverPrivateRepositories(data.context)).rejects.toMatchObject({ code: 'github_incomplete' });
    expect(data.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a backwards installation page instead of revisiting it', async () => {
    const data = fixture({ [installations()]: installationPage([], 2), [installations(2)]: installationPage([], 1) });
    await expect(discoverPrivateRepositories(data.context)).rejects.toMatchObject({ code: 'github_incomplete' });
    expect(data.request).toHaveBeenCalledTimes(2);
  });

  it('reports a repeated repository cursor and still checks the next installation', async () => {
    const data = fixture({ [installations()]: installationPage([42, 43]), [installed(42)]: repositories([], '2'), [installed(42, '2')]: repositories([], '2'), [installed(43)]: repositories([repository('retained')]) });
    expect(await discoverPrivateRepositories(data.context)).toMatchObject({ installations: 2, errors: [{ source: 'private', error: { code: 'github_incomplete' } }] });
    expect(data.onRepositories).toHaveBeenCalledWith([repository('retained')]);
    expect(data.request).toHaveBeenCalledTimes(4);
  });

  it('blocks stale private pages and the next installation after cancellation', async () => {
    const late = deferred<RepositoryPage>();
    const started = deferred<void>();
    const data = fixture({ [installations()]: installationPage([42, 43]), [installed(42)]: late.promise });
    const baseRequest = data.context.request;
    data.context.request = <T>(path: string, signal: AbortSignal): Promise<T> => {
      if (path === installed(42)) started.resolve();
      return baseRequest<T>(path, signal);
    };
    const pending = discoverPrivateRepositories(data.context);
    await started.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    data.controller.abort();
    late.resolve(repositories([repository('stale', { isPrivate: true })], '2'));
    await rejected;
    expect(data.onRepositories).not.toHaveBeenCalled();
    expect(data.request.mock.calls.map(([path]) => path)).toEqual([installations(), installed(42)]);
  });
});
