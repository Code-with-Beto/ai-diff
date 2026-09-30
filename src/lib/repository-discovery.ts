import type { InstallationsPage, Repository, RepositoryPage } from '../../shared/types';
import { isNonForkRepository } from '../../shared/repository-policy';
import { ApiError } from '../api';
import { isAuthenticationError } from './client-state';

export type DiscoveryRequest = <T>(path: string, signal: AbortSignal) => Promise<T>;
export interface DiscoveryContext {
  request: DiscoveryRequest;
  signal: AbortSignal;
  onRepositories(repositories: Repository[]): void;
}
export interface DiscoveryError<Source extends string = string> { source: Source; error: unknown }

function invalidPagination() {
  return new ApiError({ code: 'github_incomplete', message: 'GitHub returned an incomplete repository list. Please retry.' });
}

/** Publish each page immediately; cancellation also guards transports that finish after abort. */
async function repositoryPages(context: DiscoveryContext, path: string, publicOnly: boolean) {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (;;) {
    context.signal.throwIfAborted();
    const page: RepositoryPage = await context.request<RepositoryPage>(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, context.signal);
    context.signal.throwIfAborted();
    if (!Array.isArray(page.repositories)) throw invalidPagination();
    context.onRepositories(page.repositories.filter(repository => isNonForkRepository(repository) && (!publicOnly || !repository.isPrivate)));
    context.signal.throwIfAborted();
    if (!page.hasNextPage) return;
    if (typeof page.cursor !== 'string' || !page.cursor.trim() || cursors.has(page.cursor)) throw invalidPagination();
    cursors.add(page.cursor);
    cursor = page.cursor;
  }
}

/** Two independent sources can load at once without a slow source hiding the other. */
export async function discoverPublicRepositories(context: DiscoveryContext): Promise<{ errors: DiscoveryError<'owned' | 'contributed'>[] }> {
  const results = await Promise.all((['owned', 'contributed'] as const).map(async source => {
    try {
      await repositoryPages(context, `/api/github/repositories?kind=${source}`, true);
      return null;
    } catch (error) {
      context.signal.throwIfAborted();
      return { source, error };
    }
  }));
  context.signal.throwIfAborted();
  return { errors: results.filter((result): result is DiscoveryError<'owned' | 'contributed'> => result !== null) };
}

/** Read only repositories exposed by this user's existing GitHub App installations. */
export async function discoverPrivateRepositories(context: DiscoveryContext): Promise<{ installations: number; errors: DiscoveryError[] }> {
  const installationIds = new Set<number>();
  const errors: DiscoveryError[] = [];
  let pageNumber = 1;
  for (;;) {
    context.signal.throwIfAborted();
    const page = await context.request<InstallationsPage>(`/api/github/installations?page=${pageNumber}`, context.signal);
    context.signal.throwIfAborted();
    if (!Array.isArray(page.installations)) throw invalidPagination();
    for (const installation of page.installations) {
      context.signal.throwIfAborted();
      if (!Number.isSafeInteger(installation.id) || installation.id <= 0) throw invalidPagination();
      if (installationIds.has(installation.id)) continue;
      installationIds.add(installation.id);
      try {
        await repositoryPages(context, `/api/github/repositories?kind=installation&installationId=${installation.id}`, false);
      } catch (error) {
        context.signal.throwIfAborted();
        // An inaccessible installation must not hide a different organization.
        // Session expiry and throttling apply to all installations, so stop there.
        if (isAuthenticationError(error) || error instanceof ApiError && error.code === 'rate_limited') throw error;
        errors.push({ source: 'private', error });
      }
    }
    if (page.nextPage === null) return { installations: installationIds.size, errors };
    if (!Number.isSafeInteger(page.nextPage) || page.nextPage <= pageNumber) throw invalidPagination();
    pageNumber = page.nextPage;
  }
}
