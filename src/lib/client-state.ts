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
