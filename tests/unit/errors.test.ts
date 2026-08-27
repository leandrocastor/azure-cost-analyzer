import {
  AzureApiError,
  AzureAuthError,
  ConfigurationError,
  RateLimitError,
  ValidationError,
} from '@/utils/errors';

describe('error classes', () => {
  it('constructs ConfigurationError', () => {
    const error = new ConfigurationError('config');
    expect(error.name).toBe('ConfigurationError');
  });

  it('constructs ValidationError', () => {
    const error = new ValidationError('validation');
    expect(error.name).toBe('ValidationError');
  });

  it('constructs AzureAuthError with cause', () => {
    const cause = new Error('cause');
    const error = new AzureAuthError('auth', cause);
    expect(error.cause).toBe(cause);
  });

  it('constructs AzureApiError with status', () => {
    const error = new AzureApiError('api', 500);
    expect(error.statusCode).toBe(500);
  });

  it('constructs RateLimitError with retryAfter', () => {
    const error = new RateLimitError('rate', 429, 1000);
    expect(error.retryAfterMs).toBe(1000);
  });

  it('inherits RateLimitError from AzureApiError', () => {
    const error = new RateLimitError('rate');
    expect(error).toBeInstanceOf(AzureApiError);
  });
});
