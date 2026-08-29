import { SubscriptionClient } from '@azure/arm-subscriptions';
import {
  ClientSecretCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from '@azure/identity';

import { getConfig, type AppConfig } from '@/config';
import { AzureAuthError, ConfigurationError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { retry, type RetryConfig } from '@/utils/retry';

const credentialCache = new Map<string, TokenCredential>();

export type AccessibleSubscription = {
  id: string;
  displayName: string;
};

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
   * Returns the active Azure subscription id, resolved from an explicit override or
   * the configured default. Throws when neither is available.
   */
  public getSubscriptionId(subscriptionId?: string): string {
    const resolved = subscriptionId ?? this.config.AZURE_SUBSCRIPTION_ID;

    if (!resolved) {
      throw new ConfigurationError(
        'No Azure subscription specified. Pass --subscription <id>, set AZURE_SUBSCRIPTION_ID, or use the export command without --subscription to analyze every subscription the current identity can access.',
      );
    }

    return resolved;
  }

  /**
   * Returns the subscription id configured via environment/config, if any, without
   * throwing when it is absent.
   */
  public getConfiguredSubscriptionId(): string | undefined {
    return this.config.AZURE_SUBSCRIPTION_ID;
  }

  /**
   * Lists every enabled subscription the current credential can access within its
   * tenant(s). Used to run tenant-wide analyses (e.g. Azure Cloud Shell) without
   * requiring a single AZURE_SUBSCRIPTION_ID to be configured upfront.
   */
  public async listAccessibleSubscriptions(): Promise<AccessibleSubscription[]> {
    const client = new SubscriptionClient(this.getCredential());
    const subscriptions: AccessibleSubscription[] = [];

    try {
      for await (const subscription of client.subscriptions.list()) {
        if (subscription.subscriptionId && subscription.state === 'Enabled') {
          subscriptions.push({
            id: subscription.subscriptionId,
            displayName: subscription.displayName ?? subscription.subscriptionId,
          });
        }
      }
    } catch (error: unknown) {
      throw new AzureAuthError('Failed to list accessible Azure subscriptions', error);
    }

    if (subscriptions.length === 0) {
      throw new AzureAuthError(
        'No enabled Azure subscriptions were found for the authenticated identity. Sign in with "az login" or pass --subscription explicitly.',
      );
    }

    return subscriptions;
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
