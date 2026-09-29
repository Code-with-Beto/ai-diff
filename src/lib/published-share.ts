import type { SessionInfo, ShareResult } from '../../shared/types';
import preset from '../../public/share-sample.json';
import { api } from '../api';
import { decodeShare, type ShareImageTheme } from './share';

export interface PublishedShare { url: string; imageUrl: string; imageTheme: ShareImageTheme }

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function sampleShare(result: ShareResult, theme: ShareImageTheme, origin: string): PublishedShare | null {
  if (canonical(result) !== canonical(preset)) return null;
  const url = new URL(`/s/sample-${theme}`, origin).toString();
  return { url, imageUrl: `${url}/image.png`, imageTheme: theme };
}

/** Only server-rendered public pages bootstrap a stored result. Old fragments still work. */
export function readPublishedShare(): { result: ShareResult; publishedShare: PublishedShare } | null {
  if (!/^\/s\/(?:[A-Za-z0-9_-]{16}|sample-(?:light|dark))$/.test(window.location.pathname)) return null;
  const result = decodeShare(document.querySelector<HTMLMetaElement>('meta[name="ai-diff-result"]')?.content ?? '');
  const imageTheme = document.querySelector<HTMLMetaElement>('meta[name="ai-diff-image-theme"]')?.content;
  if (!result || (imageTheme !== 'dark' && imageTheme !== 'light')) return null;
  const url = new URL(window.location.pathname, window.location.origin).toString();
  return { result, publishedShare: { url, imageUrl: `${url}/image.png`, imageTheme } };
}

export async function publishShare(result: ShareResult, blob: Blob, imageTheme: ShareImageTheme, signal: AbortSignal): Promise<PublishedShare> {
  signal.throwIfAborted();
  const sample = sampleShare(result, imageTheme, window.location.origin);
  if (sample) return sample;
  if (result.sample) throw new Error('Edited samples can be shared as a PNG or with the link without upload below.');
  const session = await api<SessionInfo>('/api/session', { signal });
  if (!session.authenticated || !session.csrfToken) throw new Error('Reconnect GitHub to create a public link. Your PNG and link without upload still work.');
  if (session.user?.login.toLowerCase() !== result.login.toLowerCase()) throw new Error('You can only publish your own result. Use its existing link or download the PNG.');
  if (blob.type !== 'image/png' || blob.size > 192 * 1024) throw new Error('This image is too large for a public link. Download the PNG instead.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  signal.throwIfAborted();
  return api<PublishedShare>('/api/share', { signal, csrf: session.csrfToken, body: { result, imageTheme, image: btoa(binary), publishConsent: true } });
}
