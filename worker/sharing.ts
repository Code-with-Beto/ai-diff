import type { ShareResult, Viewer } from '../shared/types';
import { isShareResult } from '../shared/share-validation';
import { ApiError } from './github';
import { encode, origin, randomString } from './security';

export const SHARE_BODY_LIMIT = 280 * 1024;
export const SHARE_IMAGE_LIMIT = 192 * 1024;
const HEADER_LIMIT = 8192;
const RESULT_LIMIT = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ShareStore {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView): Promise<void>;
}
interface ShareEnvironment {
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  SHARE_RESULTS?: ShareStore;
}
interface ShareHeader { result: ShareResult; imageTheme: 'light' | 'dark'; createdAt: string }
interface StoredShare extends ShareHeader { png: Uint8Array<ArrayBuffer> }

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function validPng(bytes: Uint8Array<ArrayBuffer>): boolean {
  if (bytes.length > SHARE_IMAGE_LIMIT || bytes.length < 57 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let imageData = false;
  let imageDataEnded = false;
  let palette = false;
  let chunks = 0;
  while (offset + 12 <= bytes.length) {
    if (++chunks > 256) return false;
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(kind)) return false;
    let crc = 0xffffffff;
    for (let index = offset + 4; index < end - 4; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) return false;
    if (offset === 8) {
      if (kind !== 'IHDR' || length !== 13 || view.getUint32(offset + 8) !== 1200 || view.getUint32(offset + 12) !== 600) return false;
      // Browser canvas exports use 8-bit RGB or RGBA, with standard PNG methods.
      if (bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17]) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
    } else if (kind === 'IHDR') return false;
    else if (kind === 'IDAT') {
      if (imageDataEnded) return false;
      if (length > 0) imageData = true;
    } else if (kind === 'IEND') return length === 0 && imageData && end === bytes.length;
    else {
      if (imageData) imageDataEnded = true;
      if (kind === 'PLTE') {
        if (palette || imageData || length === 0 || length > 768 || length % 3 !== 0) return false;
        palette = true;
      } else if (kind[0] === kind[0].toUpperCase()) return false;
    }
    offset = end;
  }
  return false;
}

function pngFromBase64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(SHARE_IMAGE_LIMIT / 3) * 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ApiError(400, 'invalid_share_image', 'Choose a valid AI Diff PNG image under 192 KiB.');
  }
  let png: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(value);
    if (btoa(binary) !== value) throw new Error();
    png = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) png[index] = binary.charCodeAt(index);
  } catch { throw new ApiError(400, 'invalid_share_image', 'The share image is not a valid PNG.'); }
  if (!validPng(png)) throw new ApiError(400, 'invalid_share_image', 'The share image must be a valid 1200 × 600 PNG under 192 KiB.');
  return png;
}

function encodeRecord(header: ShareHeader, png: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const json = encoder.encode(JSON.stringify(header));
  if (json.byteLength > HEADER_LIMIT) throw new ApiError(400, 'invalid_share', 'This shared result is too large.');
  const record = new Uint8Array(4 + json.byteLength + png.byteLength);
  new DataView(record.buffer).setUint32(0, json.byteLength);
  record.set(json, 4);
  record.set(png, 4 + json.byteLength);
  return record;
}

function decodeRecord(record: ArrayBuffer): StoredShare {
  if (record.byteLength < 4 || record.byteLength > 4 + HEADER_LIMIT + SHARE_IMAGE_LIMIT) throw new Error('Invalid stored share');
  const size = new DataView(record).getUint32(0);
  if (size === 0 || size > HEADER_LIMIT || 4 + size >= record.byteLength) throw new Error('Invalid stored share');
  const header = JSON.parse(decoder.decode(new Uint8Array(record, 4, size))) as ShareHeader;
  if (!header || !isShareResult(header.result) || !['light', 'dark'].includes(header.imageTheme) || typeof header.createdAt !== 'string' || !Number.isFinite(Date.parse(header.createdAt))) throw new Error('Invalid stored share');
  const png = new Uint8Array(record.slice(4 + size));
  if (!validPng(png)) throw new Error('Invalid stored image');
  return { ...header, png };
}

export async function publishShare(env: ShareEnvironment, user: Viewer, input: Record<string, unknown>): Promise<Response> {
  const keys = Object.keys(input);
  if (keys.length !== 4 || !['result', 'imageTheme', 'image', 'publishConsent'].every(key => Object.hasOwn(input, key)) || !isShareResult(input.result) || !['light', 'dark'].includes(input.imageTheme as string)) {
    throw new ApiError(400, 'invalid_share', 'This shared result is invalid. Create a new result and try again.');
  }
  if (input.publishConsent !== true) throw new ApiError(400, 'share_consent_required', 'Confirm that you want to publish these totals and this image before creating a link.');
  const result = input.result;
  if (result.sample || result.login.toLowerCase() !== user.login.toLowerCase()) throw new ApiError(403, 'share_owner_required', 'You can publish only results for your connected GitHub account.');
  if (encoder.encode(JSON.stringify(result)).byteLength > RESULT_LIMIT) throw new ApiError(400, 'invalid_share', 'This shared result is too large.');
  const png = pngFromBase64(input.image);
  if (!env.SHARE_RESULTS) throw new ApiError(503, 'sharing_unavailable', 'Public links are temporarily unavailable. You can still copy or download the image.');
  const imageTheme = input.imageTheme as ShareHeader['imageTheme'];
  const id = randomString(12);
  const record = encodeRecord({ result, imageTheme, createdAt: new Date().toISOString() }, png);
  try {
    // One immutable write, without a pre-read that could cache a missing new ID.
    await env.SHARE_RESULTS.put(`share:${id}`, record);
  } catch { throw new ApiError(503, 'sharing_unavailable', 'Public link storage is temporarily full or unavailable. You can still copy or download the image.'); }
  const url = `${origin(env)}/s/${id}`;
  return new Response(JSON.stringify({ url, imageUrl: `${url}/image.png`, imageTheme }), { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function shareMeta(header: ShareHeader, url: string): string {
  const { result, imageTheme } = header;
  const number = (value: number) => value.toLocaleString('en-US');
  const partial = result.coverage.incomplete > 0 || result.coverage.unavailable > 0;
  const title = `${result.sample ? 'Sample: ' : ''}@${result.login}’s GitHub activity · AI Diff`;
  const description = [
    `${number(result.before.additions)} lines added before ${result.cutoff}; ${number(result.after.additions)} after.`,
    `${partial ? 'Partial results: ' : ''}${result.coverage.completed}/${result.coverage.total} repositories complete.`,
    ...(result.sample ? ['Fictional sample data.'] : ['Self-reported GitHub activity.']),
    ...(result.includesPrivate ? [result.sample ? 'Includes fictional private totals.' : 'Includes private totals.'] : []),
    ...(result.commitFilter?.enabled ? [`Size filter applied${result.commitFilter.scope === 'before' ? ' before only (unequal filter)' : ' to both periods'}.`] : []),
  ].join(' ');
  const attributes = (kind: 'name' | 'property', name: string, content: string) => `<meta ${kind}="${name}" content="${escapeHtml(content)}">`;
  return `<title>${escapeHtml(title)}</title>` + [
    attributes('name', 'description', description),
    attributes('property', 'og:type', 'website'), attributes('property', 'og:site_name', 'AI Diff by Code with Beto'),
    attributes('property', 'og:title', title), attributes('property', 'og:description', description), attributes('property', 'og:url', url),
    attributes('property', 'og:image', `${url}/image.png`), attributes('property', 'og:image:secure_url', `${url}/image.png`),
    attributes('property', 'og:image:type', 'image/png'), attributes('property', 'og:image:width', '1200'), attributes('property', 'og:image:height', '600'), attributes('property', 'og:image:alt', description),
    attributes('name', 'twitter:card', 'summary_large_image'), attributes('name', 'twitter:title', title), attributes('name', 'twitter:description', description), attributes('name', 'twitter:image', `${url}/image.png`), attributes('name', 'twitter:image:alt', description),
    attributes('name', 'ai-diff-result', encode(encoder.encode(JSON.stringify(result)))), attributes('name', 'ai-diff-image-theme', imageTheme),
    attributes('name', 'robots', 'noindex, nofollow'),
  ].join('');
}

async function asset(env: ShareEnvironment, path: string): Promise<Response> {
  const response = await env.ASSETS.fetch(new Request(`${origin(env)}${path}`));
  if (!response.ok) throw new ApiError(503, 'sharing_unavailable', 'This shared result is temporarily unavailable. Please try again shortly.');
  return response;
}

async function sampleShare(env: ShareEnvironment, theme: ShareHeader['imageTheme'], image: boolean): Promise<ShareHeader & { png?: Uint8Array<ArrayBuffer> }> {
  const response = await asset(env, '/share-sample.json');
  let result: unknown;
  try { result = await response.json(); } catch { throw new ApiError(503, 'sharing_unavailable', 'The sample preview is temporarily unavailable.'); }
  if (!isShareResult(result) || !result.sample) throw new ApiError(503, 'sharing_unavailable', 'The sample preview is temporarily unavailable.');
  const header: ShareHeader = { result, imageTheme: theme, createdAt: result.asOf };
  if (!image) return header;
  const png = new Uint8Array(await (await asset(env, `/share-sample-${theme}.png`)).arrayBuffer());
  if (!validPng(png)) throw new ApiError(503, 'sharing_unavailable', 'The sample image is temporarily unavailable.');
  return { ...header, png };
}

export async function publicShare(request: Request, env: ShareEnvironment, path: string): Promise<Response> {
  const match = /^\/s\/([A-Za-z0-9_-]{16}|sample-light|sample-dark)(\/image\.png)?$/.exec(path);
  if (!match) throw new ApiError(404, 'share_not_found', 'This shared result could not be found.');
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  const id = match[1];
  const image = Boolean(match[2]);
  let record: ShareHeader & { png?: Uint8Array<ArrayBuffer> };
  if (id === 'sample-light' || id === 'sample-dark') record = await sampleShare(env, id === 'sample-light' ? 'light' : 'dark', image);
  else {
    if (!env.SHARE_RESULTS) throw new ApiError(503, 'sharing_unavailable', 'Public links are temporarily unavailable. Please try again later.');
    let stored: ArrayBuffer | null;
    try { stored = await env.SHARE_RESULTS.get(`share:${id}`, 'arrayBuffer'); }
    catch { throw new ApiError(503, 'sharing_unavailable', 'Public links are temporarily unavailable. Please try again later.'); }
    if (!stored) throw new ApiError(404, 'share_not_found', 'This shared result could not be found. A newly created link may need a moment to become available.');
    try { record = decodeRecord(stored); }
    catch { throw new ApiError(503, 'sharing_unavailable', 'This shared result is temporarily unavailable.'); }
  }
  if (image) return new Response(request.method === 'HEAD' ? null : record.png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(record.png!.byteLength), 'Cache-Control': 'public, max-age=86400' } });
  // Request the asset root so canonical /index.html redirects are not involved.
  let html = await (await asset(env, '/')).text();
  html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, '').replace(/<meta\b[^>]*>/gi, tag => {
    const name = /\b(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const field = (name?.[1] ?? name?.[2] ?? name?.[3] ?? '').toLowerCase();
    return field === 'description' || field === 'robots' || field.startsWith('og:') || field.startsWith('twitter:') || field.startsWith('ai-diff-') ? '' : tag;
  });
  if (!/<\/head\s*>/i.test(html)) throw new ApiError(503, 'sharing_unavailable', 'This shared result is temporarily unavailable.');
  html = html.replace(/<\/head\s*>/i, `${shareMeta(record, `${origin(env)}/s/${id}`)}</head>`);
  return new Response(request.method === 'HEAD' ? null : html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(encoder.encode(html).byteLength), 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex, nofollow' } });
}

export function publicShareError(message: string, status: number, head: boolean): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared result · AI Diff</title><meta name="robots" content="noindex, nofollow"></head><body><main><h1>Shared result unavailable</h1><p>${escapeHtml(message)}</p><a href="/">Return to AI Diff</a></main></body></html>`;
  return new Response(head ? null : html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
}
