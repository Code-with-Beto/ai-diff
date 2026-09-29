type RequestKind = 'history' | 'files';
interface Admission { at: number; cost: number }
interface Budget {
  burst: number;
  tokens: number;
  updatedAt: number;
  admissions: Admission[];
}
interface RequestTask {
  kind: RequestKind;
  cost: number;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
interface PauseWaiter { resolve: () => void; reject: (error: unknown) => void }

const WINDOW_MS = 60_000;
const WINDOW_BUDGET = 480;
const CONCURRENCY = 4;
const MS_PER_TOKEN = WINDOW_MS / WINDOW_BUDGET;

/** One scan owns one scheduler, so repositories share concurrency and cooldowns. */
export class ScanScheduler {
  private readonly budgets: Record<RequestKind, Budget>;
  private readonly queue: RequestTask[] = [];
  private readonly pauseWaiters = new Set<PauseWaiter>();
  private active = 0;
  private pausedUntil = 0;
  private latestRateAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pumping = false;

  constructor(private readonly signal: AbortSignal, private readonly onPause?: (until: number) => void) {
    const budget = (burst: number): Budget => ({ burst, tokens: burst, updatedAt: Date.now(), admissions: [] });
    this.budgets = { history: budget(4), files: budget(8) };
    signal.addEventListener('abort', () => {
      this.clearTimer();
      const error = this.abortReason();
      for (const task of this.queue.splice(0)) task.reject(error);
      for (const waiter of this.pauseWaiters) waiter.reject(error);
      this.pauseWaiters.clear();
    }, { once: true });
  }

  /** Cost is one for a history/single-file request, or the number of batch handles. */
  run<T>(kind: RequestKind, cost: number, operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.abortReason());
    if (!Number.isInteger(cost) || cost < 1 || cost > this.budgets[kind].burst) {
      return Promise.reject(new RangeError('Invalid scan request cost.'));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ kind, cost, operation, resolve: value => resolve(value as T), reject });
      this.pump();
    });
  }

  /** Every waiter follows the longest shared pause, including later extensions. */
  pause(milliseconds: number, reason: 'rate' | 'retry' = 'retry'): Promise<void> {
    if (this.signal.aborted) return Promise.reject(this.abortReason());
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return Promise.reject(new RangeError('Invalid scan pause.'));
    // A caller may inspect a rate error only after another queued batch finishes.
    // Count backoff from the observed error so that wait is not paid twice.
    const from = reason === 'rate' ? this.latestRateAt ?? Date.now() : Date.now();
    this.extendPause(from + milliseconds);
    return new Promise<void>((resolve, reject) => {
      this.pauseWaiters.add({ resolve, reject });
      this.pump();
    });
  }

  private abortReason(): unknown {
    return this.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private extendPause(until: number): void {
    if (Number.isFinite(until) && until > Math.max(Date.now(), this.pausedUntil)) {
      this.pausedUntil = until;
      this.onPause?.(until);
    }
  }

  private observeRateLimit(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    if (record.code === 'rate_limited') {
      this.latestRateAt = Date.now();
      const seconds = typeof record.retryAfter === 'number' && Number.isFinite(record.retryAfter) ? Math.max(1, record.retryAfter) : 60;
      this.extendPause(Date.now() + seconds * 1000);
    }
    if (typeof record.remaining === 'number' && record.remaining <= 10 && typeof record.resetAt === 'string') {
      const reset = Date.parse(record.resetAt) + 1000;
      if (Number.isFinite(reset) && reset > Date.now()) this.latestRateAt = Date.now();
      this.extendPause(reset);
    }
    // Only inspect known API envelope fields; commit/file arrays are never traversed.
    if (record.initialPage) this.observeRateLimit(record.initialPage);
    if (Array.isArray(record.results)) for (const result of record.results) {
      if (typeof result === 'object' && result !== null) this.observeRateLimit(result.error ?? result.page);
    }
  }

  private budgetDelay(kind: RequestKind, cost: number, now: number): number {
    const budget = this.budgets[kind];
    budget.tokens = Math.min(budget.burst, budget.tokens + Math.max(0, now - budget.updatedAt) / MS_PER_TOKEN);
    budget.updatedAt = now;
    while (budget.admissions.length && budget.admissions[0].at <= now - WINDOW_MS) budget.admissions.shift();
    let delay = Math.max(0, Math.ceil((cost - budget.tokens) * MS_PER_TOKEN));
    let used = budget.admissions.reduce((total, admission) => total + admission.cost, 0);
    for (const admission of budget.admissions) {
      if (used + cost <= WINDOW_BUDGET) break;
      used -= admission.cost;
      delay = Math.max(delay, admission.at + WINDOW_MS - now);
    }
    return delay;
  }

  private pump(): void {
    if (this.pumping || this.signal.aborted) return;
    this.pumping = true;
    this.clearTimer();
    try {
      const now = Date.now();
      if (now < this.pausedUntil) {
        if (this.queue.length || this.pauseWaiters.size) this.wakeAfter(this.pausedUntil - now);
        return;
      }
      for (const waiter of this.pauseWaiters) waiter.resolve();
      this.pauseWaiters.clear();
      while (this.active < CONCURRENCY && this.queue.length) {
        if (this.signal.aborted) return;
        if (Date.now() < this.pausedUntil) { this.wakeAfter(this.pausedUntil - Date.now()); return; }
        let earliest = Infinity;
        const checkedKinds = new Set<RequestKind>();
        const index = this.queue.findIndex(task => {
          // Preserve FIFO within each budget. A saturated budget must not block the other.
          if (checkedKinds.has(task.kind)) return false;
          checkedKinds.add(task.kind);
          const delay = this.budgetDelay(task.kind, task.cost, now);
          earliest = Math.min(earliest, delay);
          return delay === 0;
        });
        if (index < 0) { this.wakeAfter(earliest); return; }
        const task = this.queue.splice(index, 1)[0];
        const budget = this.budgets[task.kind];
        budget.tokens -= task.cost;
        budget.admissions.push({ at: now, cost: task.cost });
        this.active++;
        void this.execute(task);
      }
    } finally { this.pumping = false; }
  }

  private wakeAfter(milliseconds: number): void {
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(1, milliseconds));
  }

  private async execute(task: RequestTask): Promise<void> {
    try {
      this.signal.throwIfAborted();
      const result = await task.operation();
      this.signal.throwIfAborted();
      // Publish a cooldown before freeing a slot or resolving to the repository loop.
      this.observeRateLimit(result);
      task.resolve(result);
    } catch (error) {
      if (!this.signal.aborted) this.observeRateLimit(error);
      task.reject(this.signal.aborted ? this.abortReason() : error);
    } finally {
      this.active--;
      this.pump();
    }
  }
}
