import type { ApiErrorBody } from '../shared/types';
export class ApiError extends Error {
  code: string; retryAfter?: number;
  constructor(body: ApiErrorBody['error']) { super(body.message); this.code = body.code; this.retryAfter = body.retryAfter; }
}
export async function api<T>(path: string, options: { body?: unknown; csrf?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, { method: options.body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: options.signal,
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json', 'x-csrf-token': options.csrf ?? '' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError({ code: 'UNAVAILABLE', message: 'AI Diff is temporarily unavailable. Please try again shortly.' }); }
  if (!response.ok) throw new ApiError((data as ApiErrorBody)?.error ?? { code: 'UNAVAILABLE', message: 'The request could not be completed.' });
  return data as T;
}
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
