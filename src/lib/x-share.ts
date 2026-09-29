import { isShareResult } from '../../shared/share-validation';
import type { ShareResult } from '../../shared/types';

export function createXPostUrl(result: ShareResult, resultUrl: string, ownResult = false): string {
  if (!isShareResult(result)) throw new Error('Create a valid result before sharing on X.');
  let link: URL;
  try {
    if (typeof resultUrl !== 'string' || resultUrl.trim() !== resultUrl || /[?#]/.test(resultUrl)) throw new Error();
    link = new URL(resultUrl);
    if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password || /^\w+:\/\/[^/]*@/.test(resultUrl)
      || !/^\/s\/(?:[A-Za-z0-9_-]{16}|sample-(?:light|dark))$/.test(link.pathname)) throw new Error();
  } catch { throw new Error('Create a public result link before sharing on X.'); }

  const caption = result.sample
    ? 'A sample AI diff. Code before and after AI.'
    : ownResult
      ? "I checked my GitHub before and after I started coding with AI. Here's my diff."
      : `Here's @${result.login}'s AI diff. Code before and after AI.`;
  const intent = new URL('https://x.com/intent/tweet');
  intent.search = new URLSearchParams({ text: caption, url: link.href }).toString();
  return intent.href;
}

export type XPostWindow = { open(url: string): boolean; close(): void };

/** Reserve during the click, before awaiting a public link, to preserve the browser's user gesture. */
export function reserveXPostWindow(): XPostWindow | null {
  let popup: Window | null = null;
  try {
    popup = window.open('about:blank', '_blank');
    if (!popup) return null;
    // Keep a local handle for navigation while denying the destination access to this tab.
    popup.opener = null;
    popup.document.title = 'Preparing your post…';
    popup.document.body.textContent = 'Preparing your post…';
  } catch {
    try { popup?.close(); } catch { /* Closing a blocked or detached window is best effort. */ }
    return null;
  }

  const reserved = popup;
  let pending = true;
  const close = () => {
    if (!pending) return;
    pending = false;
    try { if (!reserved.closed) reserved.close(); } catch { /* The user may already have closed it. */ }
  };
  return {
    open(url) {
      if (!pending) return false;
      try {
        if (reserved.closed) { pending = false; return false; }
        reserved.location.replace(url);
        pending = false;
        return true;
      } catch {
        close();
        return false;
      }
    },
    close,
  };
}
