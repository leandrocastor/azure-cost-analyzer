import {
  ClientSecretCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

import { getConfig, type AppConfig } from '@/config';
import { AzureAuthError, ValidationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { retry, type RetryConfig } from '@/utils/retry';

const credentialCache = new Map<string, TokenCredential>();

/**
 * Creates and caches Azure credentials based on the configured authentication strategy.
 */
export class AzureClientService {
  private readonly logger = createLogger({ service: 'azure-client' });

  public constructor(
    private readonly config: AppConfig = getConfig(),
    private readonly retryConfig: RetryConfig = {},
  ) {}

  /**
   * Returns the active Azure subscription id.
   */
  public getSubscriptionId(subscriptionId?: string): string {
    if (subscriptionId) {
      return subscriptionId;
    }

    if (this.isMockMode()) {
      return this.config.AZURE_SUBSCRIPTION_ID ?? 'mock-subscription';
    }

    if (!this.config.AZURE_SUBSCRIPTION_ID) {
      throw new ValidationError('AZURE_SUBSCRIPTION_ID is required when DATA_MODE=azure');
    }

    return this.config.AZURE_SUBSCRIPTION_ID;
  }

  /**
   * Indicates whether local mock datasets should be used instead of Azure APIs.
   */
  public isMockMode(): boolean {
    return this.config.DATA_MODE === 'mock';
  }

  /**
   * Returns a cached Azure credential for the configured auth method.
   */
  public getCredential(): TokenCredential {
    const cacheKey = [
      this.config.AUTH_METHOD,
      this.config.AZURE_TENANT_ID ?? '',
      this.config.AZURE_CLIENT_ID ?? '',
      this.config.AZURE_SUBSCRIPTION_ID,
    ].join(':');

    const cached = credentialCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const credential = this.createCredential();
      credentialCache.set(cacheKey, credential);
      return credential;
    } catch (error: unknown) {
      throw new AzureAuthError('Failed to initialize Azure credential', error);
    }
  }

  /**
   * Executes an Azure SDK operation with retry semantics.
   */
  public async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    return retry(operation, {
      ...this.retryConfig,
      onRetry: (attempt, error, delayMs) => {
        this.logger.warn('Retrying Azure operation', { attempt, delayMs, error: error instanceof Error ? error.message : 'unknown' });
        this.retryConfig.onRetry?.(attempt, error, delayMs);
      },
    });
  }

  private createCredential(): TokenCredential {
    if (this.config.AUTH_METHOD === 'service-principal') {
      return new ClientSecretCredential(
        this.config.AZURE_TENANT_ID ?? '',
        this.config.AZURE_CLIENT_ID ?? '',
        this.config.AZURE_CLIENT_SECRET ?? '',
      );
    }

    if (this.config.AUTH_METHOD === 'managed-identity') {
      return new ManagedIdentityCredential(
        this.config.AZURE_CLIENT_ID ? { clientId: this.config.AZURE_CLIENT_ID } : undefined,
      );
    }

    return new DefaultAzureCredential();
  }

  public static clearCredentialCache(): void {
    credentialCache.clear();
  }
}
