import { expect, it, vi } from 'vitest';
import worker from '../worker/index';
import type { Env } from '../worker/index';
import type { ScanPage } from '../shared/types';
import { cookieName, seal, sign } from '../worker/security';

/**
 * Bounded diagnostic benchmark. Measures local end-to-end wall time, NOT
 * Cloudflare CPU time. No latency threshold is asserted in automated tests.
 * Run alone with: WORKER_BENCHMARK=1 npx vitest run tests/worker-performance.test.ts
 */
it.skipIf(process.env.WORKER_BENCHMARK !== '1')('reports local scan-page timing with 100 commits after warmup', async () => {
  const env: Env = {
    APP_ORIGIN: 'https://benchmark.invalid', GITHUB_APP_SLUG: 'benchmark-only',
    GITHUB_CLIENT_ID: 'benchmark-only', GITHUB_CLIENT_SECRET: 'not-a-real-secret',
    SESSION_SECRET: btoa('0123456789abcdef0123456789abcdef'),
    ASSETS: { fetch: async () => new Response('unused') },
    API_LIMITER: { limit: async () => ({ success: true }) },
  };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: 'U_benchmark', login: 'benchmark-user', avatarUrl: 'https://avatars.githubusercontent.com/u/1' };
  const session = await seal(env, 'session', { version: 1, sessionId: 'benchmark-session', user, token: 'ghu_not-a-real-token', csrfToken: 'benchmark-csrf', expiresAt });
  const handle = await sign(env, 'scan-page', {
    version: 1, purpose: 'scan-page', sessionId: 'benchmark-session', githubUserId: user.id,
    repositoryNodeId: 'R_benchmark', headOid: 'a'.repeat(40), isPrivate: false, after: null,
    asOf: '2026-01-01T00:00:00.000Z', expiresAt,
  });
  const commits = Array.from({ length: 100 }, (_, index) => ({
    oid: (index + 1).toString(16).padStart(40, '0'),
    additions: 5 + ((index * 47) % 900), deletions: (index * 13) % 180,
    committedDate: new Date(Date.UTC(2025, 11, 31, 0, 0, 0) - index * 7200000).toISOString(),
    author: { user: { id: user.id } }, parents: { totalCount: index % 13 === 0 ? 2 : 1 },
  }));
  const githubBody = JSON.stringify({ data: {
    node: { isPrivate: false, isFork: false, object: { history: { nodes: commits, pageInfo: { hasNextPage: true, endCursor: 'benchmark-continuation-cursor' } } } },
    rateLimit: { remaining: 4000, resetAt: '2026-01-01T01:00:00.000Z' },
  } });
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async () => new Response(githubBody, { headers: { 'Content-Type': 'application/json' } }));
  const samples: number[] = [];
  let output: ScanPage | null = null;
  try {
    for (let iteration = 0; iteration < 110; iteration++) {
      const request = new Request(`${env.APP_ORIGIN}/api/scan/page`, {
        method: 'POST', headers: {
          Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'x-csrf-token': 'benchmark-csrf',
          Cookie: `${cookieName(env, 'session')}=${session}`,
        }, body: JSON.stringify({ handle }),
      });
      const started = performance.now();
      const response = await worker.fetch(request, env);
      output = await response.json() as ScanPage;
      const elapsed = performance.now() - started;
      expect(response.status).toBe(200);
      if (iteration >= 10) samples.push(elapsed);
    }
  } finally {
    vi.stubGlobal('fetch', originalFetch);
  }
  expect(output?.commits).toHaveLength(100);
  expect(output?.nextHandle).toBeTruthy();
  samples.sort((a, b) => a - b);
  const median = (samples[49] + samples[50]) / 2;
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  process.stdout.write(`${JSON.stringify({
    benchmark: 'scan-page-local-wall-time', runtime: process.version, platform: `${process.platform}/${process.arch}`,
    warmups: 10, iterations: samples.length, commitsPerPage: commits.length,
    githubFixtureBytes: new TextEncoder().encode(githubBody).byteLength,
    medianMs: Number(median.toFixed(3)), p95Ms: Number(p95.toFixed(3)),
    note: 'Local wall-time proxy with mocked GitHub fetch and rate limiter; not measured Cloudflare CPU time.',
  })}\n`);
});
