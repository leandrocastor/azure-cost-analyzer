export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class ValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AzureAuthError extends Error {
  public constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'AzureAuthError';
  }
}

export class AzureApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AzureApiError';
  }
}

export class RateLimitError extends AzureApiError {
  public constructor(message: string, statusCode = 429, public readonly retryAfterMs?: number) {
    super(message, statusCode);
    this.name = 'RateLimitError';
  }
}
