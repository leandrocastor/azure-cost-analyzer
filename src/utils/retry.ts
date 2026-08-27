import { AzureApiError, RateLimitError } from '@/utils/errors';

export type RetryConfig = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const getStatusCode = (error: unknown): number | undefined => {
  if (error instanceof AzureApiError) {
    return error.statusCode;
  }

  if (typeof error === 'object' && error !== null) {
    const statusCode = Reflect.get(error, 'statusCode');
    if (typeof statusCode === 'number') {
      return statusCode;
    }

    const status = Reflect.get(error, 'status');
    if (typeof status === 'number') {
      return status;
    }
  }

  return undefined;
};

export const isRetryableError = (error: unknown): boolean => {
  if (error instanceof RateLimitError) {
    return true;
  }

  const statusCode = getStatusCode(error);
  if (statusCode !== undefined) {
    return statusCode === 429 || statusCode >= 500;
  }

  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
  }

  return false;
};

/**
 * Retries transient operations with exponential backoff and capped delay.
 */
export const retry = async <T>(
  operation: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> => {
  const {
    maxAttempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 5_000,
    sleep = defaultSleep,
    onRetry,
  } = config;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = error instanceof RateLimitError && error.retryAfterMs
        ? Math.min(error.retryAfterMs, maxDelayMs)
        : Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

      onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry failed');
};
