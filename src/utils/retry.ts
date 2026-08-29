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

const headerNames = [
  'retry-after',
  'x-ms-retry-after-ms',
  'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-tenant-retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-client-retry-after',
];

const readHeader = (headers: unknown, name: string): string | undefined => {
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }

  const getter = Reflect.get(headers, 'get');
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  }

  const value = Reflect.get(headers, name);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
};

/**
 * Extracts an Azure-provided retry delay, in milliseconds, from a failed operation.
 * Azure throttling responses (HTTP 429) carry the required cool-down either in the
 * standard `Retry-After` header (seconds) or in service-specific variants, and
 * ignoring them causes retries to be rejected again immediately.
 */
export const getRetryAfterMs = (error: unknown): number | undefined => {
  if (error instanceof RateLimitError && error.retryAfterMs) {
    return error.retryAfterMs;
  }

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const response = Reflect.get(error, 'response');
  const headers = typeof response === 'object' && response !== null
    ? Reflect.get(response, 'headers')
    : Reflect.get(error, 'headers');

  for (const name of headerNames) {
    const raw = readHeader(headers, name);
    if (raw === undefined) {
      continue;
    }

    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      // `x-ms-retry-after-ms` is already in milliseconds; the others are in seconds.
      return name === 'x-ms-retry-after-ms' ? numeric : numeric * 1_000;
    }

    const asDate = Date.parse(raw);
    if (Number.isFinite(asDate)) {
      const deltaMs = asDate - Date.now();
      if (deltaMs > 0) {
        return deltaMs;
      }
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
 *
 * Azure throttling (HTTP 429) frequently requires cool-down windows far longer than
 * a plain exponential backoff would produce, so any server-provided retry delay takes
 * precedence over the computed one.
 */
export const retry = async <T>(
  operation: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> => {
  const {
    maxAttempts = 6,
    baseDelayMs = 250,
    maxDelayMs = 90_000,
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

      const retryAfterMs = getRetryAfterMs(error);
      const delayMs = retryAfterMs
        ? Math.min(retryAfterMs, maxDelayMs)
        : Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

      onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry failed');
};
