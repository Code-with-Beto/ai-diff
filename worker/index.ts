import type { CommitRecord, Installation, Repository, RepositoryPage, ScanPage, SessionInfo, Viewer } from '../shared/types';
import { isNonForkRepository } from '../shared/repository-policy';
import { ApiError, CONTRIBUTED_QUERY, externalFetch, github, ORGANIZATION_QUERY, OWNED_QUERY, PUBLIC_REPOSITORY_QUERY, SCAN_QUERY, SNAPSHOT_QUERY, SNAPSHOT_WITH_HISTORY_QUERY, VIEWER_QUERY } from './github';
import { challenge, cookie, decode, origin, randomString, readCookie, seal, sign, unseal, verify } from './security';
import { publicShare, publicShareError, publishShare, SHARE_BODY_LIMIT, type ShareStore } from './sharing';
import { addFileHandles, FILE_BATCH_BODY_LIMIT, scanCommitFiles, scanCommitFilesBatch } from './commit-files';

export interface Env {
  SESSION_SECRET: string;
  APP_ORIGIN: string;
  GITHUB_APP_SLUG: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  AUTH_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  API_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  SCAN_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  FILE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  SHARE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  SHARE_RESULTS?: ShareStore;
}

interface Session { version: 1; sessionId: string; user: Viewer; token: string; csrfToken: string; expiresAt: number }
interface OAuthState { state: string; verifier: string; expiresAt: number }
interface InstallState { state: string; sessionId: string; expiresAt: number }
interface ScanHandle { version: 1; purpose: 'scan-page'; sessionId: string; githubUserId: string; repositoryNodeId: string; headOid: string; isPrivate: boolean; after: string | null; asOf: string; expiresAt: number }
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RepoConnection { nodes: Repository[]; pageInfo: PageInfo }
interface RestRepository { node_id: string; full_name: string; private: boolean; fork: boolean; archived: boolean; description: string | null }
interface GithubCommit { oid: string; additions: number; deletions: number; committedDate: string; messageHeadline: string; changedFilesIfAvailable: number | null; author: { user: { id: string } | null } | null; parents: { totalCount: number } }
interface ScanHistory { nodes: GithubCommit[]; pageInfo: PageInfo }
interface ScanRateLimit { remaining: number; resetAt: string }
interface ScanData { node: { isPrivate: boolean; isFork: boolean; object: { history: ScanHistory } | null } | null; rateLimit: ScanRateLimit }
interface SnapshotData { node: (Repository & { defaultBranchRef: { target: { oid: string; history?: ScanHistory } } | null }) | null; rateLimit?: ScanRateLimit }

const now = () => Math.floor(Date.now() / 1000);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });

function configured(env: Env): boolean {
  try { return Boolean(origin(env) && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_APP_SLUG && decode(env.SESSION_SECRET).byteLength === 32); } catch { return false; }
}

async function enforceLimit(limiter: Env['API_LIMITER'], key: string): Promise<void> {
  // Bindings are optional for local development and unit tests. Production binds each limiter.
  if (limiter && !(await limiter.limit({ key })).success) {
    throw new ApiError(429, 'rate_limited', 'Too many requests. Please wait one minute and try again.', 60);
  }
}

async function getSession(request: Request, env: Env): Promise<Session | null> {
  try {
    const value = readCookie(request, env, 'session');
    if (!value) return null;
    const session = await unseal<Session>(env, 'session', value);
    if (session.version !== 1 || !session.sessionId || !session.token || !session.user?.id || !session.csrfToken || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) return null;
    return session;
  } catch { return null; }
}

async function requireSession(request: Request, env: Env): Promise<Session> {
  const session = await getSession(request, env);
  if (!session) throw new ApiError(401, 'authentication_required', 'Connect GitHub to continue.');
  return session;
}

function checkCsrf(request: Request, env: Env, session: Session): void {
  if (request.headers.get('Origin') !== origin(env) || request.headers.get('x-csrf-token') !== session.csrfToken) {
    throw new ApiError(403, 'invalid_request', 'This request could not be verified. Refresh the page and try again.');
  }
}

async function body(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'invalid_request', 'Send a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_request', 'A request body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, 'invalid_request', 'This request is too large.'); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(buffer));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_request', 'The request body is invalid.'); }
}

function string(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new ApiError(400, 'invalid_request', 'A request parameter is invalid.');
  return value;
}

function positiveInteger(value: string | null, fallback?: number): number {
  if (value === null && fallback !== undefined) return fallback;
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) throw new ApiError(400, 'invalid_request', 'A page or installation identifier is invalid.');
  return Number(value);
}

function organizationLogin(value: string | null): string {
  const input = value?.trim() ?? '';
  // Parse only supported GitHub profile forms. The input is never an outbound URL.
  const profile = /^(?:https:\/\/)?github\.com\/(?:orgs\/([A-Za-z0-9-]+)(?:\/repositories)?|([A-Za-z0-9-]+))\/?$/i.exec(input);
  const login = profile ? profile[1] ?? profile[2] : input;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new ApiError(400, 'invalid_organization', 'Enter a GitHub organization name or URL, such as Code-with-Beto or https://github.com/Code-with-Beto.');
  }
  return login;
}

function toRepository(value: RestRepository): Repository {
  if (!value || typeof value.fork !== 'boolean') throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm repository fork status. Please retry.');
  return { id: value.node_id, nameWithOwner: value.full_name, isPrivate: value.private, isFork: value.fork, isArchived: value.archived, description: value.description };
}

function nonForkRepositories(repositories: Repository[]): Repository[] {
  if (!Array.isArray(repositories) || repositories.some(repository => !repository || typeof repository.isFork !== 'boolean')) throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm repository fork status. Please retry.');
  return repositories.filter(isNonForkRepository);
}

function requireNonForkRepository(repository: { isFork: boolean }): void {
  if (typeof repository.isFork !== 'boolean') throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm repository fork status. Please retry.');
  if (!isNonForkRepository(repository)) throw new ApiError(403, 'forks_excluded', 'Forked repositories are excluded from AI Diff. Choose a non-fork repository.');
}

function repoPage(connection: RepoConnection, after: string | null = null, publicOnly = false): RepositoryPage {
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean' || (connection.pageInfo.hasNextPage && (typeof connection.pageInfo.endCursor !== 'string' || !connection.pageInfo.endCursor || connection.pageInfo.endCursor.length > 2048 || connection.pageInfo.endCursor === after))) throw new ApiError(502, 'github_incomplete', 'GitHub returned an incomplete repository list. Please retry.');
  let repositories = nonForkRepositories(connection.nodes);
  if (publicOnly) {
    if (repositories.some(repository => typeof repository.isPrivate !== 'boolean')) throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm repository visibility. Please retry.');
    repositories = repositories.filter(repository => repository.isPrivate === false);
  }
  // Filtering a whole page to zero entries must not discard its next cursor.
  return { repositories, cursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null, hasNextPage: connection.pageInfo.hasNextPage };
}

async function authStart(env: Env): Promise<Response> {
  const state: OAuthState = { state: randomString(), verifier: randomString(), expiresAt: now() + 600 };
  const target = new URL('https://github.com/login/oauth/authorize');
  target.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${origin(env)}/api/auth/github/callback`, state: state.state, code_challenge: await challenge(state.verifier), code_challenge_method: 'S256' }).toString();
  const response = redirect(target.toString());
  response.headers.append('Set-Cookie', cookie(env, 'oauth', await seal(env, 'oauth', state), 600));
  return response;
}

async function authCallback(request: Request, env: Env, url: URL): Promise<Response> {
  let state: OAuthState;
  try {
    state = await unseal<OAuthState>(env, 'oauth', readCookie(request, env, 'oauth') ?? '');
    if (!state.state || !state.verifier || state.expiresAt <= now() || url.searchParams.get('state') !== state.state) throw new Error();
  } catch { throw new ApiError(400, 'invalid_oauth_state', 'Your sign-in request expired or could not be verified. Please connect again.'); }
  if (url.searchParams.has('error')) return redirect(`${origin(env)}/?auth=cancelled`);
  const code = string(url.searchParams.get('code'));
  const exchanged = await externalFetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Code-with-Beto-AI-Diff' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${origin(env)}/api/auth/github/callback`, code_verifier: state.verifier }),
  });
  let token: { access_token?: string; expires_in?: number; error?: string };
  try { token = await exchanged.json(); } catch { throw new ApiError(502, 'oauth_exchange_invalid_response', 'GitHub could not finish sign-in. Please connect again.'); }
  if (!exchanged.ok || token.error || typeof token.access_token !== 'string' || token.access_token.length > 2048) {
    // Only these static diagnostic codes may leave this function. Never log or
    // return GitHub's error_description, token response, authorization code, or URL.
    const knownErrors: Record<string, string> = {
      incorrect_client_credentials: 'oauth_client_configuration',
      redirect_uri_mismatch: 'oauth_redirect_configuration',
      bad_verification_code: 'oauth_code_rejected',
      unverified_user_email: 'oauth_email_unverified',
    };
    const diagnostic = token.error && Object.hasOwn(knownErrors, token.error) ? knownErrors[token.error] : 'oauth_failed';
    throw new ApiError(400, diagnostic, 'GitHub could not finish sign-in. Please connect again.');
  }
  const { data } = await github<{ viewer: Viewer }>(token.access_token, '/graphql', { query: VIEWER_QUERY });
  if (!data.viewer?.id || !data.viewer.login) throw new ApiError(502, 'oauth_profile_incomplete', 'GitHub could not identify your account. Please connect again.');
  const lifetime = Math.min(typeof token.expires_in === 'number' ? token.expires_in : 28800, 28800);
  if (!Number.isFinite(lifetime) || lifetime <= 0) throw new ApiError(400, 'oauth_failed', 'GitHub returned an expired sign-in. Please connect again.');
  const session: Session = { version: 1, sessionId: randomString(), user: data.viewer, token: token.access_token, csrfToken: randomString(), expiresAt: now() + Math.floor(lifetime) };
  const response = redirect(`${origin(env)}/`);
  response.headers.append('Set-Cookie', cookie(env, 'session', await seal(env, 'session', session), Math.floor(lifetime)));
  return response;
}

async function logout(env: Env, session: Session): Promise<Response> {
  let revoked: Response;
  const revokeFailure = () => new ApiError(502, 'revoke_failed', 'You have been signed out locally, but GitHub did not confirm token revocation. You can revoke AI Diff in GitHub Settings → Applications.');
  try {
    revoked = await externalFetch(`https://api.github.com/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/token`, {
      method: 'DELETE', headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`, 'User-Agent': 'Code-with-Beto-AI-Diff' }, body: JSON.stringify({ access_token: session.token }),
    });
  } catch { throw revokeFailure(); }
  // A missing token is already revoked. All other failures must be reported honestly.
  if (!revoked.ok && revoked.status !== 404) throw revokeFailure();
  return json({ ok: true });
}

async function repositories(env: Env, session: Session, url: URL): Promise<Response> {
  const kind = url.searchParams.get('kind') ?? 'owned';
  if (kind === 'installation') {
    const installationId = positiveInteger(url.searchParams.get('installationId'));
    const page = positiveInteger(url.searchParams.get('cursor'), 1);
    const { data, response } = await github<{ repositories: RestRepository[] }>(session.token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    const hasNextPage = /rel="next"/.test(response.headers.get('link') ?? '');
    if (!Array.isArray(data.repositories)) throw new ApiError(502, 'github_incomplete', 'GitHub returned an incomplete repository list. Please retry.');
    return json({ repositories: nonForkRepositories(data.repositories.map(toRepository)), hasNextPage, cursor: hasNextPage ? String(page + 1) : null } satisfies RepositoryPage);
  }
  if (kind !== 'owned' && kind !== 'contributed' && kind !== 'organization') throw new ApiError(400, 'invalid_request', 'Choose an available repository list.');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null) string(cursor, 2048);
  if (kind === 'organization') {
    const login = organizationLogin(url.searchParams.get('organization'));
    const unavailable = () => new ApiError(404, 'organization_unavailable', 'This organization could not be found or read. Check its GitHub name and try again.');
    try {
      // Public organization history is independent of recent contribution discovery.
      // No organization membership or additional installation permission is needed.
      const { data } = await github<{ organization: { repositories: RepoConnection } | null }>(session.token, '/graphql', { query: ORGANIZATION_QUERY, variables: { login, after: cursor } });
      if (!data.organization) throw unavailable();
      return json(repoPage(data.organization.repositories, cursor, true));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'repository_unavailable') throw unavailable();
      throw error;
    }
  }
  const { data } = await github<{ viewer: { repositories?: RepoConnection; repositoriesContributedTo?: RepoConnection } }>(session.token, '/graphql', { query: kind === 'owned' ? OWNED_QUERY : CONTRIBUTED_QUERY, variables: { after: cursor } });
  return json(repoPage((kind === 'owned' ? data.viewer.repositories : data.viewer.repositoriesContributedTo)!, cursor, true));
}

async function manualRepository(session: Session, input: Record<string, unknown>): Promise<Response> {
  let target: URL;
  try { target = new URL(string(input.url, 500)); } catch { throw new ApiError(400, 'invalid_repository_url', 'Enter a public GitHub repository URL such as https://github.com/owner/repo.'); }
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(target.pathname);
  if (target.protocol !== 'https:' || target.hostname !== 'github.com' || target.port || target.username || target.password || target.search || target.hash || !match) throw new ApiError(400, 'invalid_repository_url', 'Enter a public GitHub repository URL such as https://github.com/owner/repo.');
  const { data } = await github<{ repository: Repository | null }>(session.token, '/graphql', { query: PUBLIC_REPOSITORY_QUERY, variables: { owner: match[1], name: match[2].replace(/\.git$/, '') } });
  if (!data.repository) throw new ApiError(400, 'public_repository_required', 'Add public repositories here. Use the private repository picker for private access.');
  requireNonForkRepository(data.repository);
  if (data.repository.isPrivate) throw new ApiError(400, 'public_repository_required', 'Add public repositories here. Use the private repository picker for private access.');
  return json({ repository: data.repository });
}

async function startScan(env: Env, session: Session, input: Record<string, unknown>): Promise<Response> {
  const id = string(input.repositoryId);
  const asOf = string(input.asOf, 40);
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now() + 60000) throw new ApiError(400, 'invalid_request', 'The scan date is invalid.');
  if (typeof input.includePrivate !== 'boolean') throw new ApiError(400, 'invalid_request', 'Confirm which repositories to include.');
  if (input.includeFirstPage !== undefined && typeof input.includeFirstPage !== 'boolean') throw new ApiError(400, 'invalid_request', 'The first-page option is invalid.');
  const includeFirstPage = input.includeFirstPage === true;
  const snapshotTime = new Date(timestamp).toISOString();
  const { data } = await github<SnapshotData>(session.token, '/graphql', {
    query: includeFirstPage ? SNAPSHOT_WITH_HISTORY_QUERY : SNAPSHOT_QUERY,
    variables: includeFirstPage ? { id, author: session.user.id, until: snapshotTime } : { id },
    maxResponseBytes: 256 * 1024,
  });
  if (!data.node?.id || data.node.id !== id || !data.node.nameWithOwner) throw new ApiError(403, 'repository_unavailable', 'This repository is unavailable to your GitHub connection.');
  requireNonForkRepository(data.node);
  if (typeof data.node.isPrivate !== 'boolean') throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm the repository visibility. Please retry.');
  if (data.node.isPrivate && !input.includePrivate) throw new ApiError(403, 'private_consent_required', 'Select private repositories explicitly before scanning them.');
  const { defaultBranchRef, ...repository } = data.node;
  if (defaultBranchRef === null) return json({ handle: null, repository, empty: true });
  if (!defaultBranchRef || !/^[a-f0-9]{40,64}$/.test(defaultBranchRef.target?.oid ?? '')) throw new ApiError(502, 'github_incomplete', 'GitHub could not resolve the default branch. Please retry.');
  const handle: ScanHandle = { version: 1, purpose: 'scan-page', sessionId: session.sessionId, githubUserId: session.user.id, repositoryNodeId: id, headOid: defaultBranchRef.target.oid, isPrivate: repository.isPrivate, after: null, asOf: snapshotTime, expiresAt: session.expiresAt };
  if (includeFirstPage) {
    // HEAD and its first history page come from the same query. Continuations
    // remain bound to that immutable HEAD even when the default branch advances.
    const initialPage = await createScanPage(env, session, handle, defaultBranchRef.target.history, data.rateLimit);
    return json({ handle: initialPage.nextHandle, repository, empty: false, initialPage });
  }
  return json({ handle: await sign(env, 'scan-page', handle), repository, empty: false });
}

async function scanPage(env: Env, session: Session, input: Record<string, unknown>): Promise<Response> {
  let handle: ScanHandle;
  try {
    handle = await verify<ScanHandle>(env, 'scan-page', string(input.handle, 6000));
    if (handle.version !== 1 || handle.purpose !== 'scan-page' || handle.sessionId !== session.sessionId || handle.githubUserId !== session.user.id || handle.expiresAt <= now() || !handle.repositoryNodeId || !handle.headOid || !handle.asOf) throw new Error();
  } catch { throw new ApiError(400, 'invalid_scan', 'This scan is expired or invalid. Start a new scan.'); }
  const { data } = await github<ScanData>(session.token, '/graphql', { query: SCAN_QUERY, variables: { id: handle.repositoryNodeId, head: handle.headOid, author: session.user.id, after: handle.after, until: handle.asOf }, maxResponseBytes: 256 * 1024 });
  // Recheck live metadata, including handles issued before fork exclusion existed.
  if (data.node) requireNonForkRepository(data.node);
  if (data.node?.isPrivate && !handle.isPrivate) throw new ApiError(403, 'repository_visibility_changed', 'This repository became private during the scan. Select it from your private repositories and start a new scan.');
  if (data.node && typeof data.node.isPrivate !== 'boolean') throw new ApiError(502, 'github_incomplete', 'GitHub could not confirm the repository visibility. Please retry this page.');
  return json(await createScanPage(env, session, handle, data.node?.object?.history, data.rateLimit));
}

async function createScanPage(
  env: Env, session: Session, handle: ScanHandle,
  history: ScanHistory | undefined, rateLimit: ScanRateLimit | undefined,
): Promise<ScanPage> {
  if (!history || !Array.isArray(history.nodes) || !history.pageInfo || typeof history.pageInfo.hasNextPage !== 'boolean' || (history.pageInfo.hasNextPage && (typeof history.pageInfo.endCursor !== 'string' || !history.pageInfo.endCursor || history.pageInfo.endCursor.length > 2048 || history.pageInfo.endCursor === handle.after))) throw new ApiError(502, 'github_incomplete', 'GitHub could not read this snapshot. Retry, or start a new scan.');
  if (history.nodes.length > 100) throw new ApiError(502, 'github_incomplete', 'GitHub returned too many commits in this page. Please retry.');
  const records: CommitRecord[] = history.nodes.map((commit) => {
    if (!/^[a-f0-9]{40,64}$/.test(commit?.oid ?? '') || !Number.isSafeInteger(commit.additions) || commit.additions < 0 || !Number.isSafeInteger(commit.deletions) || commit.deletions < 0 || !Number.isSafeInteger(commit.parents?.totalCount) || commit.parents.totalCount < 0 || !Number.isFinite(Date.parse(commit.committedDate)) || (commit.changedFilesIfAvailable != null && (!Number.isSafeInteger(commit.changedFilesIfAvailable) || commit.changedFilesIfAvailable < 0))) throw new ApiError(502, 'github_incomplete', 'GitHub returned incomplete commit statistics. Please retry this page.');
    return { oid: commit.oid, additions: commit.additions, deletions: commit.deletions, committedDate: commit.committedDate, authorId: commit.author?.user?.id ?? null, parentCount: commit.parents.totalCount, headline: typeof commit.messageHeadline === 'string' ? commit.messageHeadline.slice(0, 240) : '', changedFiles: commit.changedFilesIfAvailable ?? null };
  // Commit.author is the primary Git author. Commit.authors can also contain
  // Co-authored-by trailers; being a coauthor or committer does not qualify.
  }).filter(commit => commit.authorId === session.user.id);
  if (!rateLimit || !Number.isSafeInteger(rateLimit.remaining) || rateLimit.remaining < 0 || !Number.isFinite(Date.parse(rateLimit.resetAt))) throw new ApiError(502, 'github_incomplete', 'GitHub returned incomplete rate-limit information. Please retry this page.');
  const commits = await addFileHandles(env, session, handle, records);
  const nextHandle = history.pageInfo.hasNextPage ? await sign(env, 'scan-page', { ...handle, after: history.pageInfo.endCursor }) : null;
  return { commits, nextHandle, remaining: rateLimit.remaining, resetAt: rateLimit.resetAt };
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === '/api/session' && request.method === 'GET') {
    if (!configured(env)) return json({ configured: false, authenticated: false } satisfies SessionInfo);
    const session = await getSession(request, env);
    return json(session ? { configured: true, authenticated: true, user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt } satisfies SessionInfo : { configured: true, authenticated: false } satisfies SessionInfo);
  }
  if (!configured(env)) throw new ApiError(503, 'not_configured', 'GitHub connection is not configured yet. You can explore the sample report.');
  if (path === '/api/auth/github/start' && request.method === 'GET') {
    await enforceLimit(env.AUTH_LIMITER, `auth:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    return authStart(env);
  }
  if (path === '/api/auth/github/callback' && request.method === 'GET') return authCallback(request, env, url);
  const session = await requireSession(request, env);
  if (request.method === 'POST') checkCsrf(request, env, session);
  // Always let an authenticated user revoke and clear a session, even after a scan hits the limit.
  if (path === '/api/auth/logout' && request.method === 'POST') return logout(env, session);
  // File reads are separately bounded because a full audit may inspect thousands
  // of commits. They retain session + CSRF checks and never bypass GitHub limits.
  if (path === '/api/scan/files' && request.method === 'POST') {
    await enforceLimit(env.FILE_LIMITER, `files:user:${session.user.id}`);
    await enforceLimit(env.FILE_LIMITER, `files:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    return json(await scanCommitFiles(env, session, await body(request)));
  }
  if (path === '/api/scan/files/batch' && request.method === 'POST') {
    // Invalid authenticated payloads still consume one unit, as on the single route.
    await enforceLimit(env.FILE_LIMITER, `files:user:${session.user.id}`);
    await enforceLimit(env.FILE_LIMITER, `files:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    return json(await scanCommitFilesBatch(env, session, await body(request, FILE_BATCH_BODY_LIMIT), async pages => {
      // The allowance counts upstream file pages, not batch envelopes. Charge
      // remaining pages before GitHub access; a partially charged refusal stays safe.
      for (let index = 1; index < pages; index++) {
        await enforceLimit(env.FILE_LIMITER, `files:user:${session.user.id}`);
        await enforceLimit(env.FILE_LIMITER, `files:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
      }
    }));
  }
  // Large accounts can need hundreds of history pages even when all file
  // details are already verified. Keep this allowance separate from discovery.
  if ((path === '/api/scan/start' || path === '/api/scan/page') && request.method === 'POST') {
    await enforceLimit(env.SCAN_LIMITER, `scan:user:${session.user.id}`);
    await enforceLimit(env.SCAN_LIMITER, `scan:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    const input = await body(request);
    return path === '/api/scan/start' ? startScan(env, session, input) : scanPage(env, session, input);
  }
  await enforceLimit(env.API_LIMITER, `user:${session.user.id}`);
  if (path === '/api/share' && request.method === 'POST') {
    await enforceLimit(env.SHARE_LIMITER, `share:user:${session.user.id}`);
    await enforceLimit(env.SHARE_LIMITER, `share:ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`);
    return publishShare(env, session.user, await body(request, SHARE_BODY_LIMIT));
  }
  if (path === '/api/github/install' && request.method === 'POST') {
    const state: InstallState = { state: randomString(), sessionId: session.sessionId, expiresAt: now() + 1800 };
    const response = json({ url: `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new?state=${state.state}` });
    response.headers.append('Set-Cookie', cookie(env, 'install', await seal(env, 'install', state), 1800));
    return response;
  }
  if (path === '/api/github/setup' && request.method === 'GET') {
    try {
      const state = await unseal<InstallState>(env, 'install', readCookie(request, env, 'install') ?? '');
      if (state.state !== url.searchParams.get('state') || state.sessionId !== session.sessionId || state.expiresAt <= now()) throw new Error();
    } catch { throw new ApiError(400, 'invalid_installation_state', 'This installation return could not be verified. Return to AI Diff and refresh your private repositories.'); }
    return redirect(`${origin(env)}/?private=connected`);
  }
  if (path === '/api/github/installations' && request.method === 'GET') {
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const { data, response } = await github<{ installations: { id: number; account: { login: string }; suspended_at: string | null }[] }>(session.token, `/user/installations?per_page=100&page=${page}`);
    const installations: Installation[] = data.installations.filter((installation) => !installation.suspended_at).map((installation) => ({ id: installation.id, login: installation.account.login }));
    return json({ installations, nextPage: /rel="next"/.test(response.headers.get('link') ?? '') ? page + 1 : null });
  }
  if (path === '/api/github/repositories' && request.method === 'GET') return repositories(env, session, url);
  if (path === '/api/github/repository' && request.method === 'POST') return manualRepository(session, await body(request));
  throw new ApiError(404, 'not_found', 'This API route does not exist.');
}

function secureResponse(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('Referrer-Policy', 'no-referrer');
  secured.headers.set('X-Frame-Options', 'DENY');
  secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://avatars.githubusercontent.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com");
  return secured;
}

async function cachedPublicShare(request: Request, env: Env, url: URL, context?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  let cache: Cache | undefined;
  let key: Request | undefined;
  if (context && ['GET', 'HEAD'].includes(request.method)) {
    try {
      cache = typeof caches === 'undefined' ? undefined : (caches as CacheStorage & { default?: Cache }).default;
      // Public content depends only on the immutable path, never cookies or query strings.
      if (cache) {
        key = new Request(`${origin(env)}${url.pathname}`, { method: 'GET' });
        const cached = await cache.match(key);
        if (cached?.status === 200) return request.method === 'HEAD' ? new Response(null, cached) : cached;
      }
    } catch { cache = undefined; key = undefined; }
  }
  // A HEAD miss generates a full GET response so no empty body enters the cache.
  const response = await publicShare(request.method === 'HEAD' ? new Request(request.url, { method: 'GET' }) : request, env, url.pathname);
  if (cache && key && context && response.status === 200) {
    try { context.waitUntil(cache.put(key, response.clone()).catch(() => {})); }
    catch { /* Caching is an optimization; a failure must not break a valid share. */ }
  }
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

export default {
  async fetch(request: Request, env: Env, context?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    const sharedPath = url.pathname.startsWith('/s/');
    if (!url.pathname.startsWith('/api/') && !sharedPath) return secureResponse(await env.ASSETS.fetch(request));
    let response: Response;
    let clearLogout = false;
    let clearStaleSession = false;
    try {
      // Only an authenticated, CSRF-verified logout may clear the cookie.
      if (url.pathname === '/api/auth/logout' && request.method === 'POST' && configured(env)) {
        const session = await requireSession(request, env);
        checkCsrf(request, env, session);
        clearLogout = true;
      }
      response = sharedPath ? await cachedPublicShare(request, env, url, context) : await route(request, env, url);
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(500, 'server_error', 'The request could not be completed. Please try again.');
      if (url.pathname === '/api/auth/github/callback') console.warn('auth_callback_failed', failure.code);
      clearStaleSession = failure.code === 'session_expired';
      const browserAuthRoute = request.method === 'GET' && ['/api/auth/github/start', '/api/auth/github/callback', '/api/github/setup'].includes(url.pathname);
      let appOrigin: string | null = null;
      try { appOrigin = origin(env); } catch { /* An invalid configured origin must never become a redirect. */ }
      if (sharedPath) response = publicShareError(failure.message, failure.status, request.method === 'HEAD');
      else if (browserAuthRoute && appOrigin) {
        const auth = failure.code === 'rate_limited' ? 'rate_limited' : url.pathname === '/api/github/setup' ? 'installation_failed' : failure.code === 'invalid_oauth_state' || failure.code === 'session_expired' ? 'expired' : 'failed';
        response = redirect(`${appOrigin}/?auth=${auth}`);
      } else {
        response = json({ error: { code: failure.code, message: failure.message, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) } }, failure.status);
      }
      if (failure.retryAfter) response.headers.set('Retry-After', String(failure.retryAfter));
      if (url.pathname === '/api/auth/github/callback') response.headers.set('X-AIDiff-Error-Code', failure.code);
    }
    if (configured(env)) {
      if (url.pathname === '/api/auth/github/callback') response.headers.append('Set-Cookie', cookie(env, 'oauth', '', 0));
      if (url.pathname === '/api/github/setup') response.headers.append('Set-Cookie', cookie(env, 'install', '', 0));
      if (clearStaleSession && !clearLogout) response.headers.append('Set-Cookie', cookie(env, 'session', '', 0));
      if (clearLogout) {
        for (const name of ['session', 'oauth', 'install']) response.headers.append('Set-Cookie', cookie(env, name, '', 0));
      }
    }
    return secureResponse(response);
  },
};
