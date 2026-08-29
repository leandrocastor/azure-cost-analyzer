import { DEFAULT_QPU_WINDOWS, QpuLimiter } from '@/utils/qpu-limiter';

type Harness = {
  limiter: QpuLimiter;
  advance: (ms: number) => void;
  slept: number[];
  currentTime: () => number;
};

const createHarness = (windows = DEFAULT_QPU_WINDOWS): Harness => {
  let clock = 1_000_000;
  const slept: number[] = [];

  const limiter = new QpuLimiter({
    windows,
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  });

  return {
    limiter,
    advance: (ms: number) => {
      clock += ms;
    },
    slept,
    currentTime: () => clock,
  };
};

describe('QpuLimiter', () => {
  describe('estimateCost', () => {
    it('charges one unit per started month', () => {
      expect(QpuLimiter.estimateCost('2026-01-01', '2026-03-31')).toBe(3);
    });

    it('charges at least one unit for short ranges', () => {
      expect(QpuLimiter.estimateCost('2026-01-01', '2026-01-02')).toBe(1);
    });

    it('spans year boundaries', () => {
      expect(QpuLimiter.estimateCost('2025-11-01', '2026-02-01')).toBe(4);
    });

    it('falls back to one unit for invalid dates', () => {
      expect(QpuLimiter.estimateCost('not-a-date', '2026-01-01')).toBe(1);
    });
  });

  it('allows spending that fits the budget without waiting', async () => {
    const { limiter, slept } = createHarness();

    await limiter.acquire(3);
    await limiter.acquire(3);

    expect(slept).toEqual([]);
  });

  it('waits for the ten second window before overspending', async () => {
    const { limiter, slept } = createHarness();

    await limiter.acquire(6);
    await limiter.acquire(6);
    await limiter.acquire(3);

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(10_000);
  });

  it('does not wait once earlier spends age out of the window', async () => {
    const { limiter, slept, advance } = createHarness();

    await limiter.acquire(12);
    advance(10_001);
    await limiter.acquire(12);

    expect(slept).toEqual([]);
  });

  it('honors the one minute window after the ten second window clears', async () => {
    const { limiter, slept, advance } = createHarness();

    for (let index = 0; index < 5; index += 1) {
      await limiter.acquire(12);
      advance(10_001);
    }

    // 60 QPU are now spent within the minute, so the next call has to wait.
    await limiter.acquire(1);

    expect(slept.length).toBeGreaterThan(0);
  });

  it('blocks every caller during a throttling penalty', async () => {
    const { limiter, slept } = createHarness();

    limiter.penalize(45_000);
    expect(limiter.penaltyRemainingMs).toBe(45_000);

    await limiter.acquire(1);

    expect(slept).toEqual([45_000]);
    expect(limiter.penaltyRemainingMs).toBe(0);
  });

  it('keeps the longest penalty when several responses report a cool-down', async () => {
    const { limiter } = createHarness();

    limiter.penalize(20_000);
    limiter.penalize(5_000);

    expect(limiter.penaltyRemainingMs).toBe(20_000);
  });

  it('ignores non-positive penalties', () => {
    const { limiter } = createHarness();

    limiter.penalize(0);
    limiter.penalize(-10);

    expect(limiter.penaltyRemainingMs).toBe(0);
  });

  it('serializes concurrent acquisitions so a window cannot be overspent', async () => {
    const { limiter, slept } = createHarness();

    await Promise.all([limiter.acquire(6), limiter.acquire(6), limiter.acquire(6)]);

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBe(10_000);
  });

  it('keeps working after a queued acquisition rejects', async () => {
    const failing = new QpuLimiter({
      windows: [],
      sleep: async () => {
        throw new Error('sleep failed');
      },
    });

    failing.penalize(1_000);
    await expect(failing.acquire(1)).rejects.toThrow('sleep failed');
    await expect(failing.acquire(1)).rejects.toThrow('sleep failed');
  });

  it('reports why it is waiting', async () => {
    const reasons: { delayMs: number; reason: string }[] = [];
    const { limiter } = createHarness();
    limiter.setWaitReporter((delayMs, reason) => {
      reasons.push({ delayMs, reason });
    });

    limiter.penalize(30_000);
    await limiter.acquire(1);

    expect(reasons).toEqual([{ delayMs: 30_000, reason: 'throttled' }]);
  });

  it('reports quota waits separately from throttling waits', async () => {
    const reasons: string[] = [];
    const { limiter } = createHarness();
    limiter.setWaitReporter((_delayMs, reason) => {
      reasons.push(reason);
    });

    await limiter.acquire(12);
    await limiter.acquire(12);

    expect(reasons).toEqual(['quota']);
  });

  it('lets an oversized query through instead of waiting forever', async () => {
    const { limiter, slept } = createHarness([{ durationMs: 10_000, limit: 12 }]);

    await limiter.acquire(50);

    expect(slept).toEqual([]);
  });
});
