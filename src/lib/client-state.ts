import { isDateOnly } from './analysis';

/** A request may finish after abort. Identity checks prevent stale UI writes. */
export function createOperationScope() {
  const tasks = new Map<string, AbortController>();
  return {
    start(key: string) {
      tasks.get(key)?.abort();
      const controller = new AbortController();
      tasks.set(key, controller);
      return {
        signal: controller.signal,
        isCurrent: () => tasks.get(key) === controller,
        isActive: () => tasks.get(key) === controller && !controller.signal.aborted,
        finish: () => { if (tasks.get(key) === controller) tasks.delete(key); },
      };
    },
    cancel(key: string) { tasks.get(key)?.abort(); },
    invalidateAll() { tasks.forEach(controller => controller.abort()); tasks.clear(); },
  };
}

export function isAuthenticationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'authentication_required' || error.code === 'session_expired');
}

export function comparisonDateAllowed(value: string, maximum: string): boolean {
  return isDateOnly(value) && value >= '1970-01-01' && value <= maximum;
}

export function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  return /^github\.com\//i.test(trimmed) ? `https://${trimmed}` : trimmed;
}

export function parseRepositorySource(value: string): { kind: 'organization'; login: string } | { kind: 'repository'; url: string } {
  const input = value.trim();
  const login = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
  const validLogin = (candidate: string) => login.test(candidate) && !candidate.includes('--');
  if (validLogin(input)) return { kind: 'organization', login: input };
  const normalized = normalizeRepositoryUrl(input);
  const address = /^[a-z\d-]+\/[a-z\d_.-]+\/?$/i.test(normalized) ? `https://github.com/${normalized}` : normalized;
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error();
    const path = url.pathname.replace(/\/$/, '').split('/').slice(1);
    if (path.length === 1 && validLogin(path[0])) return { kind: 'organization', login: path[0] };
    if (path[0] === 'orgs' && validLogin(path[1] ?? '') && (path.length === 2 || (path.length === 3 && path[2] === 'repositories'))) return { kind: 'organization', login: path[1] };
    if (path.length === 2 && validLogin(path[0]) && /^[a-z\d_.-]+$/i.test(path[1])) return { kind: 'repository', url: url.toString() };
  } catch { /* Return one helpful message for malformed or unsupported sources. */ }
  throw new Error('Enter an organization name or a GitHub repository URL. For example: Code-with-Beto or github.com/owner/repo.');
}

export function callbackMessage(search: string): string {
  const params = new URLSearchParams(search);
  const messages: Record<string, string> = {
    cancelled: 'GitHub connection was canceled. Connect again whenever you’re ready.',
    expired: 'Your sign-in request expired. Connect GitHub again to continue.',
    failed: 'GitHub connection did not finish. Please try connecting again.',
    rate_limited: 'GitHub is temporarily limiting requests. Wait a minute, then connect again.',
    installation_failed: 'Private repository setup did not finish. Refresh access below or choose your repositories on GitHub again.',
  };
  const key = params.get('auth') ?? '';
  return Object.hasOwn(messages, key) ? messages[key] : params.has('error') ? messages.failed : '';
}
