// Local workerd probe only. Not imported by the production Worker.
import { externalFetch } from './github';
export default {
  async fetch(): Promise<Response> {
    const probes: { label: string; init: () => RequestInit }[] = [
      { label: 'baseline', init: () => ({}) },
      { label: 'redirect-error', init: () => ({ redirect: 'error' }) },
      { label: 'abort-timeout', init: () => ({ signal: AbortSignal.timeout(15000) }) },
      { label: 'combined', init: () => ({ redirect: 'error', signal: AbortSignal.timeout(15000) }) },
      { label: 'redirect-manual', init: () => ({ redirect: 'manual', signal: AbortSignal.timeout(15000) }) },
    ];
    const results = [];
    for (const probe of probes) {
      const start = performance.now();
      try {
        const response = await fetch('https://api.github.com/zen', { headers: { 'User-Agent': 'Code-with-Beto-AI-Diff' }, ...probe.init() });
        await response.arrayBuffer();
        results.push({ label: probe.label, status: response.status, wallMs: Math.round(performance.now() - start) });
      } catch (error) {
        results.push({ label: probe.label, kind: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'unknown', wallMs: Math.round(performance.now() - start) });
      }
    }
    const helperStart = performance.now();
    try {
      const response = await externalFetch('https://api.github.com/zen', { headers: { 'User-Agent': 'Code-with-Beto-AI-Diff' } });
      await response.arrayBuffer();
      results.push({ label: 'production-helper', status: response.status, wallMs: Math.round(performance.now() - helperStart) });
    } catch { results.push({ label: 'production-helper', kind: 'failed', wallMs: Math.round(performance.now() - helperStart) }); }
    return Response.json(results);
  },
};
