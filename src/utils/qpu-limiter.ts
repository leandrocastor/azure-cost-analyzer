/**
 * Azure Cost Management bills every Query API call in Query Processing Units (QPU),
 * deducting roughly one QPU per month of data requested. Microsoft documents the
 * following per-tenant sliding windows:
 *
 *   - 12 QPU per 10 seconds
 *   - 60 QPU per 1 minute
 *   - 600 QPU per 1 hour
 *
 * Analyzing several subscriptions back-to-back exhausts the 10-second window almost
 * immediately (4 subscriptions x 3 months = 12 QPU), which is why unpaced runs are
 * rejected with HTTP 429. This limiter spends the budget deliberately instead of
 * discovering the limit by being throttled.
 *
 * @see https://learn.microsoft.com/azure/cost-management-billing/costs/manage-automation
 */

export type QpuWindow = {
  durationMs: number;
  limit: number;
};

export const DEFAULT_QPU_WINDOWS: QpuWindow[] = [
  { durationMs: 10_000, limit: 12 },
  { durationMs: 60_000, limit: 60 },
  { durationMs: 3_600_000, limit: 600 },
];

type Spend = {
  at: number;
  cost: number;
};

export type QpuLimiterOptions = {
  windows?: QpuWindow[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (delayMs: number, reason: 'quota' | 'throttled') => void;
};

/** Safety valve so a stalled clock can never trap a caller in the wait loop. */
const MAX_WAIT_ITERATIONS = 50;

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Paces Cost Management queries so they stay inside the documented QPU budget.
 *
 * Calls are serialized: concurrent callers queue behind each other, which keeps the
 * accounting correct when several subscriptions are analyzed in the same run.
 */
export class QpuLimiter {
  private readonly windows: QpuWindow[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private onWait: ((delayMs: number, reason: 'quota' | 'throttled') => void) | undefined;

  private spends: Spend[] = [];
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  public constructor(options: QpuLimiterOptions = {}) {
    this.windows = options.windows ?? DEFAULT_QPU_WINDOWS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.onWait = options.onWait;
  }

  /**
   * Registers a callback invoked whenever the limiter has to wait, so callers can
   * surface the reason to the user rather than appearing to hang.
   */
  public setWaitReporter(onWait: (delayMs: number, reason: 'quota' | 'throttled') => void): void {
    this.onWait = onWait;
  }

  /**
   * Estimates the QPU cost of a query: one unit per started month in the range,
   * with a floor of one so short ranges are still accounted for.
   */
  public static estimateCost(startDate: string | Date, endDate: string | Date): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return 1;
    }

    const months =
      (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      (end.getUTCMonth() - start.getUTCMonth()) +
      1;

    return Math.max(1, months);
  }

  /**
   * Waits until the given cost fits the budget, then records the spend.
   * Calls are serialized so concurrent callers cannot overspend the same window.
   */
  public async acquire(cost: number): Promise<void> {
    const run = this.queue.then(async () => {
      await this.waitForBudget(Math.max(1, cost));
    });

    // Keep the chain alive even if a caller rejects, so later acquisitions still run.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Records a throttling response so every subsequent query waits out the cool-down,
   * instead of each subscription rediscovering the limit on its own.
   */
  public penalize(retryAfterMs: number): void {
    if (retryAfterMs <= 0) {
      return;
    }
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + retryAfterMs);
  }

  /**
   * Milliseconds remaining on an active throttling penalty, or zero when clear.
   */
  public get penaltyRemainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  private async waitForBudget(cost: number): Promise<void> {
    // A cool-down can be extended while we are already waiting, so re-evaluate.
    // The iteration cap prevents an unbounded loop if the clock never advances.
    for (let iteration = 0; iteration < MAX_WAIT_ITERATIONS; iteration += 1) {
      const penalty = this.penaltyRemainingMs;
      if (penalty > 0) {
        this.onWait?.(penalty, 'throttled');
        await this.sleep(penalty);
        continue;
      }

      const delayMs = this.delayUntilAffordable(cost);
      if (delayMs <= 0) {
        break;
      }

      this.onWait?.(delayMs, 'quota');
      await this.sleep(delayMs);
    }

    this.spends.push({ at: this.now(), cost });
  }

  /**
   * Returns how long to wait before `cost` fits every window, or 0 when it fits now.
   */
  private delayUntilAffordable(cost: number): number {
    const now = this.now();
    const longestWindow = Math.max(...this.windows.map((window) => window.durationMs));
    this.spends = this.spends.filter((spend) => now - spend.at < longestWindow);

    let delayMs = 0;

    for (const window of this.windows) {
      const windowStart = now - window.durationMs;
      const relevant = this.spends.filter((spend) => spend.at > windowStart);
      const used = relevant.reduce((sum, spend) => sum + spend.cost, 0);

      if (used + cost <= window.limit) {
        continue;
      }

      // Wait until enough of the oldest spends age out of this window.
      let freed = 0;
      const needed = used + cost - window.limit;
      const ordered = [...relevant].sort((left, right) => left.at - right.at);

      for (const spend of ordered) {
        freed += spend.cost;
        if (freed >= needed) {
          delayMs = Math.max(delayMs, spend.at + window.durationMs - now);
          break;
        }
      }

      // A single query larger than the whole window budget can never fit; let it
      // through and rely on retry/penalty handling rather than waiting forever.
      if (freed < needed) {
        delayMs = Math.max(delayMs, 0);
      }
    }

    return delayMs;
  }
}

/**
 * Process-wide limiter. The QPU budget is enforced per tenant, so every Cost
 * Management query in a run must share the same accounting.
 */
export const costManagementQpuLimiter = new QpuLimiter();
