export interface CryptoEnvironment { SESSION_SECRET: string; APP_ORIGIN: string }

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(value)) throw new Error('Invalid encoding');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomString(bytes = 32): string {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function key(env: CryptoEnvironment, purpose: string, algorithm: 'AES-GCM' | 'HMAC'): Promise<CryptoKey> {
  const secret = decode(env.SESSION_SECRET);
  if (secret.byteLength !== 32) throw new Error('Invalid session configuration');
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('ai-diff:v1'), info: encoder.encode(purpose) },
    material,
    algorithm === 'AES-GCM' ? { name: algorithm, length: 256 } : { name: algorithm, hash: 'SHA-256', length: 256 },
    false,
    algorithm === 'AES-GCM' ? ['encrypt', 'decrypt'] : ['sign', 'verify'],
  );
}

export async function seal(env: CryptoEnvironment, purpose: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    await key(env, purpose, 'AES-GCM'), encoder.encode(JSON.stringify(value)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function unseal<T>(env: CryptoEnvironment, purpose: string, value: string): Promise<T> {
  if (value.length > 6000) throw new Error('Invalid envelope');
  const parts = value.split('.');
  if (parts.length !== 2) throw new Error('Invalid envelope');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(parts[0]), additionalData: encoder.encode(purpose) },
    await key(env, purpose, 'AES-GCM'), decode(parts[1]),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export async function createSigner(env: CryptoEnvironment, purpose: string): Promise<(value: unknown) => Promise<string>> {
  // Reuse only within the calling request. A history page may issue 100 scoped
  // file handles; deriving the same purpose key for every commit wastes CPU.
  const signingKey = await key(env, purpose, 'HMAC');
  return async (value: unknown) => {
    const payload = encode(encoder.encode(JSON.stringify(value)));
    const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(payload));
    return `${payload}.${encode(new Uint8Array(signature))}`;
  };
}

export async function sign<T>(env: CryptoEnvironment, purpose: string, value: T): Promise<string> {
  return (await createSigner(env, purpose))(value);
}

export async function verify<T>(env: CryptoEnvironment, purpose: string, token: string): Promise<T> {
  if (token.length > 6000) throw new Error('Invalid envelope');
  const parts = token.split('.');
  if (parts.length !== 2 || !await crypto.subtle.verify('HMAC', await key(env, purpose, 'HMAC'), decode(parts[1]), encoder.encode(parts[0]))) {
    throw new Error('Invalid envelope');
  }
  return JSON.parse(decoder.decode(decode(parts[0]))) as T;
}

export async function challenge(verifier: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

export function origin(env: CryptoEnvironment): string {
  const url = new URL(env.APP_ORIGIN);
  if (url.origin !== env.APP_ORIGIN || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Invalid origin configuration');
  }
  return url.origin;
}

export function cookieName(env: CryptoEnvironment, name: string): string {
  return `${origin(env).startsWith('https:') ? '__Host-' : ''}aidiff-${name}`;
}

export function cookie(env: CryptoEnvironment, name: string, value: string, maxAge: number): string {
  return `${cookieName(env, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
}

export function readCookie(request: Request, env: CryptoEnvironment, name: string): string | null {
  const prefix = `${cookieName(env, name)}=`;
  return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}
