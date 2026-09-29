import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api';
import { ScanScheduler } from '../src/lib/scan-scheduler';

const START = Date.UTC(2026, 8, 29);
const flush = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe('shared scan scheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps at most four requests active across repositories and preserves returned values', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const pending = Array.from({ length: 12 }, () => deferred<number>());
    let active = 0, peak = 0, calls = 0;
    const results = pending.map((item, index) => scheduler.run('files', 1, async () => {
      calls++; active++; peak = Math.max(peak, active);
      try { return await item.promise; } finally { active--; }
    }).then(result => expect(result).toBe(index)));
    expect(calls).toBe(4);
    pending[2].resolve(2); await flush(); expect(calls).toBe(5);
    for (let i = 0; i < pending.length; i++) pending[i].resolve(i);
    await vi.runAllTimersAsync(); await Promise.all(results);
    expect(peak).toBe(4); expect(calls).toBe(12);
  });

  it('allows small scans immediately, then smooths weighted file pages', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const starts: number[] = [];
    const jobs = Array.from({ length: 7 }, () => scheduler.run('files', 2, async () => { starts.push(Date.now() - START); }));
    await flush(); expect(starts).toEqual([0, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(249); expect(starts).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1); expect(starts).toEqual([0, 0, 0, 0, 250]);
    await vi.runAllTimersAsync(); await Promise.all(jobs);
    expect(starts).toEqual([0, 0, 0, 0, 250, 500, 750]);
  });

  it('paces history separately with four immediate requests and an eight-per-second refill', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const starts: number[] = [];
    const jobs = Array.from({ length: 7 }, () => scheduler.run('history', 1, async () => { starts.push(Date.now() - START); }));
    await vi.runAllTimersAsync(); await Promise.all(jobs);
    expect(starts).toEqual([0, 0, 0, 0, 125, 250, 375]);
  });

  it.each([['history', 1], ['files', 2]] as const)('never exceeds 480 cost units in any rolling minute for %s', async (kind, cost) => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const starts: number[] = [];
    const jobs = Array.from({ length: 1050 / cost }, () => scheduler.run(kind, cost, async () => { starts.push(Date.now()); }));
    await vi.runAllTimersAsync(); await Promise.all(jobs);
    for (const now of starts) expect(starts.filter(at => at > now - 60_000 && at <= now).length * cost).toBeLessThanOrEqual(480);
    expect(starts.at(-1)! - START).toBeGreaterThan(120_000);
  });

  it('keeps FIFO within a budget without starving ready work from the other budget', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const events: string[] = [];
    const jobs = Array.from({ length: 8 }, (_, index) => scheduler.run('files', 2, async () => { events.push(`files${index}`); }));
    jobs.push(scheduler.run('history', 1, async () => { events.push('history'); }));
    await flush(); expect(events).toEqual(['files0', 'files1', 'files2', 'files3', 'history']);
    await vi.runAllTimersAsync(); await Promise.all(jobs);
    expect(events.filter(event => event.startsWith('files'))).toEqual(Array.from({ length: 8 }, (_, i) => `files${i}`));
  });

  it('publishes a thrown rate limit before a newly free slot starts queued work, without retrying', async () => {
    const deadlines: number[] = [], events: number[] = [];
    const scheduler = new ScanScheduler(new AbortController().signal, until => { deadlines.push(until); });
    const rate = new ApiError({ code: 'rate_limited', message: 'Slow down', retryAfter: 90 });
    const first = scheduler.run('history', 1, async () => { throw rate; }).catch(error => error);
    const peers = Array.from({ length: 3 }, () => deferred<void>());
    const active = peers.map(peer => scheduler.run('files', 1, () => peer.promise));
    const queued = scheduler.run('history', 1, async () => { events.push(Date.now()); });
    await flush(); expect(await first).toBe(rate); expect(deadlines).toEqual([START + 90_000]);
    peers.forEach(peer => peer.resolve()); await flush(); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(89_999); expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await Promise.all([...active, queued]);
    expect(events).toEqual([START + 90_000]);
  });

  it('uses the longest per-item batch cooldown before other repositories can continue', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const result = { results: [
      { oid: 'one', error: { code: 'rate_limited', retryAfter: 60 } },
      { oid: 'two', error: { code: 'rate_limited', retryAfter: 120 } },
    ] };
    expect(await scheduler.run('files', 2, async () => result)).toBe(result);
    let started = false;
    const queued = scheduler.run('history', 1, async () => { started = true; });
    await vi.advanceTimersByTimeAsync(119_999); expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await queued; expect(started).toBe(true);
  });

  it.each(['page', 'batch', 'start'])('observes a low remaining quota in a %s response', async envelope => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const page = { remaining: 10, resetAt: new Date(START + 20_000).toISOString() };
    const result = envelope === 'page' ? page : envelope === 'batch' ? { results: [{ oid: 'a', page }] } : { initialPage: page };
    await scheduler.run('history', 1, async () => result);
    let started = false;
    const queued = scheduler.run('files', 1, async () => { started = true; });
    await vi.advanceTimersByTimeAsync(20_999); expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await queued; expect(started).toBe(true);
  });

  it('extends all pause waiters and queued requests to the same latest deadline', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const completed: string[] = [];
    const first = scheduler.pause(1000).then(() => { completed.push('first'); });
    await vi.advanceTimersByTimeAsync(500);
    const second = scheduler.pause(2000).then(() => { completed.push('second'); });
    const queued = scheduler.run('files', 1, async () => { completed.push('request'); });
    await vi.advanceTimersByTimeAsync(1999); expect(completed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await Promise.all([first, second, queued]);
    expect(completed.sort()).toEqual(['first', 'request', 'second']);
  });

  it('does not charge a second rate cooldown when a queued batch sibling settles after the first pause', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const first = scheduler.run('files', 2, async () => ({ results: [{ error: { code: 'rate_limited', retryAfter: 60 } }] }));
    await first;
    const sibling = scheduler.run('files', 2, async () => ({ results: [] }));
    await vi.advanceTimersByTimeAsync(61_000); await sibling;
    await scheduler.pause(60_000, 'rate');
    expect(vi.getTimerCount()).toBe(0);
    expect(await scheduler.run('history', 1, async () => Date.now() - START)).toBe(61_000);
    // A longer exponential retry still extends the original error's deadline.
    let resumed = false;
    const backoff = scheduler.pause(120_000, 'rate').then(() => { resumed = true; });
    await vi.advanceTimersByTimeAsync(58_999); expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await backoff; expect(resumed).toBe(true);
  });

  it('starts an ordinary network retry pause from now even after an earlier rate cooldown', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    await scheduler.run('files', 1, async () => ({ results: [{ error: { code: 'rate_limited', retryAfter: 60 } }] }));
    await vi.advanceTimersByTimeAsync(61_000);
    let resumed = false;
    const pause = scheduler.pause(1000, 'retry').then(() => { resumed = true; });
    await vi.advanceTimersByTimeAsync(999); expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pause; expect(resumed).toBe(true);
  });

  it('rejects queued requests and pause waiters on cancellation and discards late active results', async () => {
    const controller = new AbortController(), scheduler = new ScanScheduler(controller.signal);
    const active = deferred<number>(); let calls = 0;
    const running = scheduler.run('history', 1, () => active.promise).catch(error => error);
    const pause = scheduler.pause(90_000).catch(error => error);
    const queued = scheduler.run('files', 2, async () => { calls++; }).catch(error => error);
    controller.abort(); active.resolve(42);
    for (const result of await Promise.all([running, pause, queued])) expect(result).toMatchObject({ name: 'AbortError' });
    await expect(scheduler.run('history', 1, async () => { calls++; })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(scheduler.pause(1)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync(); expect(calls).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates operation failures and frees the slot without retrying them', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    const failure = new Error('Broken connection'); let calls = 0;
    await expect(scheduler.run('history', 1, async () => { calls++; throw failure; })).rejects.toBe(failure);
    expect(await scheduler.run('history', 1, async () => 42)).toBe(42);
    expect(calls).toBe(1);
  });

  it('rejects invalid cost or pause input instead of leaving work queued forever', async () => {
    const scheduler = new ScanScheduler(new AbortController().signal);
    for (const cost of [0, -1, 1.5, NaN, Infinity, 9]) await expect(scheduler.run('files', cost, async () => 1)).rejects.toThrow(RangeError);
    for (const duration of [-1, NaN, Infinity]) await expect(scheduler.pause(duration)).rejects.toThrow(RangeError);
    await scheduler.pause(0); expect(vi.getTimerCount()).toBe(0);
  });
});
