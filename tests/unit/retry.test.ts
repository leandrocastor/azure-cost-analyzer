import { AzureApiError, RateLimitError } from '@/utils/errors';
import { isRetryableError, retry } from '@/utils/retry';

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
});
