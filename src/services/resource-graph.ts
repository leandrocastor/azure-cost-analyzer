import { ResourceGraphClient } from '@azure/arm-resourcegraph';

import { AzureClientService } from '@/services/azure-client';
import { createLogger } from '@/utils/logger';

/**
 * A resource's real creation timestamp is not exposed by the individual
 * management SDKs (Compute, Web, Storage, ...), only by Azure Resource Graph,
 * which indexes `properties.creationTime` and `systemData.createdAt` across
 * resource types. Querying it is what lets the aging detector state "this
 * resource is 812 days old" as a confirmed fact instead of a guess.
 */
const CREATION_TIME_QUERY = `
Resources
| extend createdTime = tostring(coalesce(properties.creationTime, properties.createdTime, systemData.createdAt))
| where isnotempty(createdTime)
| project id, createdTime
`;

type ResourceGraphClientLike = {
  resources: (query: { subscriptions?: string[]; query: string }) => Promise<{ data?: unknown }>;
};

/**
 * Resolves confirmed creation timestamps for resources via Azure Resource
 * Graph. Every consumer must treat a missing entry as "unknown", never as
 * "recently created" — the whole point of this service is to avoid the aging
 * detector fabricating an age for resources it cannot actually confirm.
 */
export class ResourceGraphService {
  private readonly logger = createLogger({ service: 'resource-graph' });
  private readonly client: ResourceGraphClientLike;

  public constructor(private readonly azureClient = new AzureClientService()) {
    this.client = new ResourceGraphClient(this.azureClient.getCredential()) as unknown as ResourceGraphClientLike;
  }

  /**
   * Returns a map of resource id (lowercased) to ISO creation timestamp for
   * every resource Resource Graph can confirm in the given subscription.
   * Never throws: a failure here must not prevent the rest of the export
   * pipeline from producing a report, so it degrades to an empty map with a
   * logged warning, and the aging detector simply skips resources it cannot
   * confirm.
   */
  public async getCreationTimes(subscriptionId: string): Promise<Map<string, string>> {
    try {
      const response = await this.azureClient.executeWithRetry(() =>
        this.client.resources({ subscriptions: [subscriptionId], query: CREATION_TIME_QUERY }),
      );

      const rows = Array.isArray(response.data) ? (response.data as { id?: string; createdTime?: string }[]) : [];
      const creationTimes = new Map<string, string>();

      for (const row of rows) {
        if (row.id && row.createdTime) {
          creationTimes.set(row.id.toLowerCase(), row.createdTime);
        }
      }

      return creationTimes;
    } catch (error) {
      this.logger.warn('Could not resolve resource creation times via Resource Graph; aging findings will be skipped', {
        subscriptionId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return new Map();
    }
  }
}
