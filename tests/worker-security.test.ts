import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSigner, createVerifier, decode, encode, sign, verify } from '../worker/security';

const env = { APP_ORIGIN: 'https://security.example', SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef') };
afterEach(() => vi.restoreAllMocks());

describe('request-local capability verification', () => {
  it('derives once while authenticating each concurrent token independently', async () => {
    const signer = await createSigner(env, 'commit-files');
    const values = Array.from({ length: 4 }, (_, index) => ({ oid: String(index), sessionId: 'session' }));
    const tokens = await Promise.all(values.map(signer));
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    const check = vi.spyOn(crypto.subtle, 'verify');
    const verifier = await createVerifier(env, 'commit-files');
    expect(await Promise.all(tokens.map(token => verifier(token)))).toEqual(values);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('rejects tampering, wrong purposes, oversized envelopes, and a different request secret', async () => {
    const token = await sign(env, 'commit-files', { oid: 'a'.repeat(40), sessionId: 'session' });
    const verifier = await createVerifier(env, 'commit-files');
    const [payload, signature] = token.split('.');
    const tampered = `${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    await expect(verifier(tampered)).rejects.toThrow();
    await expect(verifier('a'.repeat(6001))).rejects.toThrow();
    await expect(verifier('not.an.envelope')).rejects.toThrow();
    await expect((await createVerifier(env, 'scan-page'))(token)).rejects.toThrow();
    const rotated = { ...env, SESSION_SECRET: btoa('fedcba9876543210fedcba9876543210') };
    await expect((await createVerifier(rotated, 'commit-files'))(token)).rejects.toThrow();
    expect(await verify(env, 'commit-files', token)).toEqual({ oid: 'a'.repeat(40), sessionId: 'session' });
  });

  it('round-trips every byte with the bounded decoder and rejects invalid base64', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decode(encode(bytes))).toEqual(bytes);
    expect(() => decode('invalid!')).toThrow();
  });
});
