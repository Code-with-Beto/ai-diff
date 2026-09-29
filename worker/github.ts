export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}

export const GITHUB_API_VERSION = '2026-03-10';

function retryDelay(response: Response): number | undefined {
  const retry = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0) return Math.ceil(retry);
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - Date.now() / 1000));
  }
  return undefined;
}

export async function externalFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    // workerd accepts "manual" and "follow", but rejects the browser/Node
    // "error" redirect mode before making a request. Never follow redirects
    // with GitHub credentials: inspect and reject the response explicitly.
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ApiError(502, 'github_unexpected_redirect', 'GitHub returned an unexpected redirect. Please try again.');
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof TypeError) throw new ApiError(502, 'github_fetch_type_error', 'The GitHub request could not be started. Please try again.');
    if (error instanceof Error && error.name === 'TimeoutError') throw new ApiError(502, 'github_timeout', 'GitHub took too long to respond. Please try again.');
    if (error instanceof Error && error.name === 'AbortError') throw new ApiError(502, 'github_request_aborted', 'The GitHub request was interrupted. Please try again.');
    throw new ApiError(502, 'github_unavailable', 'GitHub could not be reached. Please try again.');
  }
}

async function readJson(response: Response, maximum?: number): Promise<unknown> {
  if (maximum === undefined) return response.json();
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    await response.body?.cancel();
    throw new ApiError(502, 'github_response_too_large', 'GitHub returned more detail than this scan can safely inspect.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new ApiError(502, 'github_response_too_large', 'GitHub returned more detail than this scan can safely inspect.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export async function github<T>(token: string, path: string, options: { query?: string; variables?: Record<string, unknown>; maxResponseBytes?: number } = {}): Promise<{ data: T; response: Response }> {
  const response = await externalFetch(`https://api.github.com${path}`, {
    method: options.query ? 'POST' : 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'Code-with-Beto-AI-Diff', ...(options.query ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.query ? { body: JSON.stringify({ query: options.query, variables: options.variables }) } : {}),
  });
  const retryAfter = retryDelay(response);
  if (response.status === 401) throw new ApiError(401, 'session_expired', 'Your GitHub session has expired. Please connect again.');
  if (response.status === 429 || (response.status === 403 && retryAfter)) {
    throw new ApiError(429, 'rate_limited', 'GitHub has paused this scan. Please wait before retrying.', retryAfter ?? 60);
  }
  if (response.status === 403) {
    const failure = await readJson(response, options.maxResponseBytes).catch(() => null) as { message?: string } | null;
    if (/rate limit|abuse detection/i.test(failure?.message ?? '')) throw new ApiError(429, 'rate_limited', 'GitHub has paused this scan. Please wait before retrying.', retryAfter ?? 60);
  }
  if (response.status === 403 || response.status === 404) throw new ApiError(403, 'repository_unavailable', 'This repository is unavailable to your GitHub connection. Check the app permissions or organization approval.');
  if (!response.ok) throw new ApiError(502, 'github_unavailable', 'GitHub could not complete this request. Please retry.');
  let body: unknown;
  try { body = await readJson(response, options.maxResponseBytes); } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'github_unavailable', 'GitHub returned an unreadable response. Please retry.');
  }
  if (options.query) {
    const result = body as { data?: T; errors?: { type?: string; message?: string }[] };
    // Partial GraphQL responses must never become apparently complete results.
    if (result.errors?.length) {
      if (result.errors.some((error) => error.type === 'RATE_LIMITED' || /rate limit/i.test(error.message ?? ''))) {
        throw new ApiError(429, 'rate_limited', 'GitHub has paused this scan. Please wait before retrying.', retryAfter ?? 60);
      }
      if (result.errors.some((error) => ['FORBIDDEN', 'NOT_FOUND'].includes(error.type ?? ''))) {
        throw new ApiError(403, 'repository_unavailable', 'This repository is no longer available to your GitHub connection.');
      }
      throw new ApiError(502, 'github_incomplete', 'GitHub returned an incomplete response. Retry this page to continue the scan.');
    }
    if (!result.data) throw new ApiError(502, 'github_incomplete', 'GitHub returned no scan data. Please retry.');
    return { data: result.data, response };
  }
  return { data: body as T, response };
}

export const REPOSITORY_FIELDS = 'id nameWithOwner isPrivate isFork isArchived description';
export const VIEWER_QUERY = 'query Viewer { viewer { id login avatarUrl } }';
export const OWNED_QUERY = `query Owned($after: String) { viewer { repositories(first: 100, after: $after, ownerAffiliations: [OWNER], privacy: PUBLIC, isFork: false, orderBy: {field: NAME, direction: ASC}) { nodes { ${REPOSITORY_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const CONTRIBUTED_QUERY = `query Contributed($after: String) { viewer { repositoriesContributedTo(first: 100, after: $after, contributionTypes: [COMMIT], includeUserRepositories: false, privacy: PUBLIC, orderBy: {field: NAME, direction: ASC}) { nodes { ${REPOSITORY_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const ORGANIZATION_QUERY = `query OrganizationRepositories($login: String!, $after: String) { organization(login: $login) { repositories(first: 100, after: $after, ownerAffiliations: [OWNER], privacy: PUBLIC, isFork: false, orderBy: {field: NAME, direction: ASC}) { nodes { ${REPOSITORY_FIELDS} } pageInfo { hasNextPage endCursor } } } }`;
export const PUBLIC_REPOSITORY_QUERY = `query PublicRepository($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${REPOSITORY_FIELDS} } }`;
export const SNAPSHOT_QUERY = `query Snapshot($id: ID!) { node(id: $id) { ... on Repository { ${REPOSITORY_FIELDS} defaultBranchRef { target { ... on Commit { oid } } } } } }`;
export const FILE_REPOSITORY_QUERY = `query FileRepository($id: ID!) { node(id: $id) { ... on Repository { id databaseId nameWithOwner isPrivate isFork } } }`;
export const SCAN_QUERY = `query ScanPage($id: ID!, $head: GitObjectID!, $author: ID!, $after: String, $until: GitTimestamp!) {
  node(id: $id) { ... on Repository { isPrivate isFork object(oid: $head) { ... on Commit {
    history(first: 100, after: $after, author: {id: $author}, until: $until) {
      nodes { oid additions deletions committedDate messageHeadline changedFilesIfAvailable author { user { id } } parents(first: 1) { totalCount } }
      pageInfo { hasNextPage endCursor }
    }
  } } } }
  rateLimit { remaining resetAt }
}`;
