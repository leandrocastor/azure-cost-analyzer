import { AzureApiError, RateLimitError } from '@/utils/errors';
import { getRetryAfterMs, isRetryableError, isThrottlingError, retry } from '@/utils/retry';

describe('retry', () => {
  it('returns on first success', async () => {
    const result = await retry(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('retries transient Azure API errors', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new AzureApiError('boom', 500);
        }
        return 'done';
      },
      { sleep: async (ms) => delays.push(ms) },
    );
    expect(result).toBe('done');
    expect(delays).toEqual([250, 500]);
  });

  it('honors rate limit retry-after delays', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RateLimitError('slow down', 429, 1234);
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms) },
    );
    expect(delays).toEqual([1234]);
  });

  it('caps exponential delays', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts < 4) {
          throw new AzureApiError('fail', 503);
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms), maxDelayMs: 300, maxAttempts: 4 },
    );
    expect(delays).toEqual([250, 300, 300]);
  });

  it('throws when max attempts are exhausted', async () => {
    await expect(
      retry(
        async () => {
          throw new AzureApiError('nope', 500);
        },
        { maxAttempts: 2, sleep: async () => undefined },
      ),
    ).rejects.toThrow('nope');
  });

  it('does not retry non-transient errors', async () => {
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts += 1;
        throw new AzureApiError('bad request', 400);
      }),
    ).rejects.toThrow('bad request');
    expect(attempts).toBe(1);
  });

  it.each([
    new RateLimitError('rate', 429),
    new AzureApiError('server', 500),
    { statusCode: 429 },
    { status: 503 },
    { code: 'ETIMEDOUT' },
  ])('classifies retryable errors', (error) => {
    expect(isRetryableError(error)).toBe(true);
  });

  it.each([
    new AzureApiError('client', 404),
    new Error('plain'),
    { code: 'ENOENT' },
  ])('classifies non-retryable errors', (error) => {
    expect(isRetryableError(error)).toBe(false);
  });

  it('invokes onRetry callback', async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new AzureApiError('retry me', 500);
        }
        return 'ok';
      },
      { onRetry, sleep: async () => undefined },
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('honors the Retry-After response header returned by Azure throttling', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Too many requests. Please retry.'), {
            statusCode: 429,
            response: { headers: { get: (name: string) => (name === 'retry-after' ? '30' : undefined) } },
          });
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms) },
    );
    expect(delays).toEqual([30_000]);
  });

  it('honors millisecond retry hints from x-ms-retry-after-ms', () => {
    const error = Object.assign(new Error('throttled'), {
      statusCode: 429,
      response: { headers: { get: (name: string) => (name === 'x-ms-retry-after-ms' ? '4500' : undefined) } },
    });
    expect(getRetryAfterMs(error)).toBe(4_500);
  });

  it('honors Cost Management specific retry headers', () => {
    const error = Object.assign(new Error('throttled'), {
      statusCode: 429,
      headers: { 'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after': '60' },
    });
    expect(getRetryAfterMs(error)).toBe(60_000);
  });

  it('returns undefined when no retry hint is present', () => {
    expect(getRetryAfterMs(new AzureApiError('boom', 500))).toBeUndefined();
    expect(getRetryAfterMs('not an object')).toBeUndefined();
  });

  it('caps server-provided retry delays at maxDelayMs', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new RateLimitError('slow down', 429, 500_000);
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms), maxDelayMs: 90_000 },
    );
    expect(delays).toEqual([90_000]);
  });

  it('retries throttled operations more than three times by default', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 6) {
          throw new RateLimitError('throttled', 429);
        }
        return 'ok';
      },
      { sleep: async () => undefined },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(6);
  });

  it('reads the documented Cost Management QPU retry header', () => {
    const error = {
      statusCode: 429,
      response: { headers: { 'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after': '47' } },
    };
    expect(getRetryAfterMs(error)).toBe(47_000);
  });

  it('reads retry headers regardless of casing', () => {
    const error = {
      statusCode: 429,
      response: { headers: { 'X-MS-RateLimit-Microsoft.CostManagement-QPU-Retry-After': '12' } },
    };
    expect(getRetryAfterMs(error)).toBe(12_000);
  });

  it('detects throttling from the SDK message when no status code is present', () => {
    expect(isThrottlingError(new Error('Too many requests. Please retry.'))).toBe(true);
    expect(isRetryableError(new Error('Too many requests. Please retry.'))).toBe(true);
    expect(isThrottlingError(new Error('boom'))).toBe(false);
  });

  it('applies a floor to throttling backoff so retries stop burning quota', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('Too many requests. Please retry.');
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms), baseDelayMs: 250, throttleFloorMs: 15_000 },
    );
    expect(delays).toEqual([15_000, 15_000]);
  });

  it('keeps the short backoff for non-throttling failures', async () => {
    const delays: number[] = [];
    let attempts = 0;
    await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new AzureApiError('server error', 500);
        }
        return 'ok';
      },
      { sleep: async (ms) => delays.push(ms), baseDelayMs: 250, throttleFloorMs: 15_000 },
    );
    expect(delays).toEqual([250, 500]);
  });
});
