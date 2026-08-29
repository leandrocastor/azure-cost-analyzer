import { WebSiteManagementClient } from '@azure/arm-appservice';
import { ComputeManagementClient } from '@azure/arm-compute';
import { MonitorClient } from '@azure/arm-monitor';
import { NetworkManagementClient } from '@azure/arm-network';
import { SqlManagementClient } from '@azure/arm-sql';
import { StorageManagementClient } from '@azure/arm-storage';

import type { IdleResource, Resource, ResourceMetric } from '@/models';
import { IdleResourceSchema } from '@/models';
import { AzureClientService } from '@/services/azure-client';
import { AzureApiError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';

type MetricPoint = { average?: number; total?: number; timestamp?: Date | string };
type MetricSeries = { data?: MetricPoint[] };
type MetricValue = { name?: { value?: string }; unit?: string; timeseries?: MetricSeries[] };
type MetricsResult = { value?: MetricValue[] };

type ResourceLike = {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  sku?: { name?: string };
  tags?: Record<string, string>;
  properties?: Record<string, unknown>;
};

type ComputeClientLike = {
  virtualMachines: { listAll: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
  disks: { list: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
};

type AppServiceClientLike = {
  webApps: { list: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
};

type StorageClientLike = {
  storageAccounts: { list: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
};

type SqlClientLike = {
  servers: { list: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
  databases: { listByServer: (resourceGroup: string, serverName: string) => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
};

type NetworkClientLike = {
  publicIPAddresses: { listAll: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
  loadBalancers: { listAll: () => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
};

type MonitorClientLike = {
  metrics: {
    list: (resourceId: string, options: Record<string, unknown>) => Promise<MetricsResult>;
  };
};

const resourceGroupFromId = (resourceId: string): string => {
  const match = resourceId.match(/resourceGroups\/([^/]+)/i);
  return match?.[1] ?? 'unknown-rg';
};

const toArray = async <T>(iterable: AsyncIterable<T> | Iterable<T>): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
};

/**
 * Detects idle or underutilized Azure resources by correlating inventory and metrics.
 */
export class ResourceDetectorService {
  private readonly logger = createLogger({ service: 'resource-detector' });
  private readonly monitorClient: MonitorClientLike;
  private readonly computeClient: ComputeClientLike;
  private readonly networkClient: NetworkClientLike;
  private readonly storageClient: StorageClientLike;
  private readonly sqlClient: SqlClientLike;
  private readonly appServiceClient: AppServiceClientLike;

  public constructor(
    private readonly azureClient = new AzureClientService(),
    subscriptionIdOverride?: string,
  ) {
    const credential = this.azureClient.getCredential();
    const subscriptionId = this.azureClient.getSubscriptionId(subscriptionIdOverride);
    this.monitorClient = new MonitorClient(credential, subscriptionId) as unknown as MonitorClientLike;
    this.computeClient = new ComputeManagementClient(credential, subscriptionId) as unknown as ComputeClientLike;
    this.networkClient = new NetworkManagementClient(credential, subscriptionId) as unknown as NetworkClientLike;
    this.storageClient = new StorageManagementClient(credential, subscriptionId) as unknown as StorageClientLike;
    this.sqlClient = new SqlManagementClient(credential, subscriptionId) as unknown as SqlClientLike;
    this.appServiceClient = new WebSiteManagementClient(credential, subscriptionId) as unknown as AppServiceClientLike;
  }

  /**
   * Detects virtual machines with consistently low CPU usage.
   */
  public async detectIdleVMs(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const vms = await toArray(this.computeClient.virtualMachines.listAll());
      const idleResources: IdleResource[] = [];

      for (const vm of vms) {
        const resource = this.normalizeResource(vm, 'Microsoft.Compute/virtualMachines');
        const metrics = await this.getMetrics(resource.id, 'Percentage CPU', 'PT1H', 'avg');
        const avgCpu = this.metricAverage(metrics);
        if (avgCpu < 5) {
          idleResources.push(this.buildIdleResource(resource, 'CPU média abaixo de 5% nos últimos 7 dias', metrics, 92, 120));
        }
      }

      return idleResources;
    }, 'Failed to detect idle VMs');
  }

  /**
   * Detects App Services with low request volume.
   */
  public async detectIdleAppServices(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const apps = await toArray(this.appServiceClient.webApps.list());
      const idleResources: IdleResource[] = [];

      for (const app of apps) {
        const resource = this.normalizeResource(app, 'Microsoft.Web/sites');
        const metrics = await this.getMetrics(resource.id, 'Requests', 'P1D', 'sum');
        const dailyRequests = this.metricAverage(metrics);
        if (dailyRequests < 100) {
          idleResources.push(this.buildIdleResource(resource, 'Menos de 100 requisições por dia', metrics, 78, 65));
        }
      }

      return idleResources;
    }, 'Failed to detect idle App Services');
  }

  /**
   * Detects storage accounts with no recent access patterns.
   */
  public async detectIdleStorage(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const accounts = await toArray(this.storageClient.storageAccounts.list());
      const idleResources: IdleResource[] = [];

      for (const account of accounts) {
        const resource = this.normalizeResource(account, 'Microsoft.Storage/storageAccounts');
        const metrics = await this.getMetrics(resource.id, 'Transactions', 'P1D', 'sum');
        const avgTransactions = this.metricAverage(metrics);
        if (avgTransactions === 0) {
          idleResources.push(this.buildIdleResource(resource, 'Sem transações de storage nos últimos 30 dias', metrics, 85, 40));
        }
      }

      return idleResources;
    }, 'Failed to detect idle storage');
  }

  /**
   * Detects SQL databases with low DTU consumption.
   */
  public async detectIdleSqlDatabases(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const servers = await toArray(this.sqlClient.servers.list());
      const idleResources: IdleResource[] = [];

      for (const server of servers) {
        const serverId = server.id ?? '';
        const resourceGroup = resourceGroupFromId(serverId);
        const databases = await toArray(this.sqlClient.databases.listByServer(resourceGroup, server.name ?? ''));

        for (const database of databases) {
          const resource = this.normalizeResource(database, 'Microsoft.Sql/servers/databases');
          const metrics = await this.getMetrics(resource.id, 'dtu_consumption_percent', 'PT1H', 'avg');
          const avgDtu = this.metricAverage(metrics);
          if (avgDtu < 5) {
            idleResources.push(this.buildIdleResource(resource, 'Consumo de DTU abaixo de 5%', metrics, 80, 90));
          }
        }
      }

      return idleResources;
    }, 'Failed to detect idle SQL databases');
  }

  /**
   * Detects unattached managed disks.
   */
  public async detectUnattachedDisks(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const disks = await toArray(this.computeClient.disks.list());
      return disks
        .filter((disk) => !Reflect.get(disk.properties ?? {}, 'managedBy'))
        .map((disk) => this.buildIdleResource(this.normalizeResource(disk, 'Microsoft.Compute/disks'), 'Disco não está anexado a nenhuma VM', [], 95, 30));
    }, 'Failed to detect unattached disks');
  }

  /**
   * Detects public IPs that are not associated with resources.
   */
  public async detectUnusedPublicIPs(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const ips = await toArray(this.networkClient.publicIPAddresses.listAll());
      return ips
        .filter((ip) => !Reflect.get(ip.properties ?? {}, 'ipConfiguration'))
        .map((ip) => this.buildIdleResource(this.normalizeResource(ip, 'Microsoft.Network/publicIPAddresses'), 'Public IP não está associado a nenhum recurso', [], 88, 15));
    }, 'Failed to detect unused public IPs');
  }

  /**
   * Detects load balancers with no backend pool associations.
   */
  public async detectUnusedLoadBalancers(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const loadBalancers = await toArray(this.networkClient.loadBalancers.listAll());
      return loadBalancers
        .filter((lb) => {
          const backendPools = Reflect.get(lb.properties ?? {}, 'backendAddressPools');
          return !Array.isArray(backendPools) || backendPools.length === 0;
        })
        .map((lb) => this.buildIdleResource(this.normalizeResource(lb, 'Microsoft.Network/loadBalancers'), 'Load balancer sem backend pools configurados', [], 84, 25));
    }, 'Failed to detect unused load balancers');
  }

  /**
   * Runs every detector and returns a consolidated list.
   */
  public async detectAll(): Promise<IdleResource[]> {
    const results = await Promise.all([
      this.detectIdleVMs(),
      this.detectIdleAppServices(),
      this.detectIdleStorage(),
      this.detectIdleSqlDatabases(),
      this.detectUnattachedDisks(),
      this.detectUnusedPublicIPs(),
      this.detectUnusedLoadBalancers(),
    ]);
    return results.flat().sort((left, right) => right.estimatedMonthlySavings - left.estimatedMonthlySavings);
  }

  /**
   * Maps the shorthand aggregation identifiers used across this service to the
   * capitalized aggregation type names required by the Azure Monitor Metrics API.
   */
  private normalizeAggregation(aggregation: string): string {
    const aggregationMap: Record<string, string> = {
      avg: 'Average',
      average: 'Average',
      sum: 'Total',
      total: 'Total',
      min: 'Minimum',
      minimum: 'Minimum',
      max: 'Maximum',
      maximum: 'Maximum',
      count: 'Count',
      last: 'Last',
      none: 'None',
    };

    return aggregationMap[aggregation.toLowerCase()] ?? aggregation;
  }

  private async wrapDetection<T>(operation: () => Promise<T>, message: string): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      this.logger.error(message, { error: error instanceof Error ? error.message : 'unknown' });
      throw new AzureApiError(message, 500, error);
    }
  }

  private async getMetrics(resourceId: string, metricName: string, interval: string, aggregation: string): Promise<ResourceMetric[]> {
    // The Azure Monitor Metrics API only accepts capitalized aggregation type names
    // (e.g. "Average", "Total"), not the lowercase shorthand used internally here.
    const normalizedAggregation = this.normalizeAggregation(aggregation);
    const result = await this.azureClient.executeWithRetry(() =>
      this.monitorClient.metrics.list(resourceId, {
        timespan: this.buildTimespan(aggregation === 'sum' ? 30 : 7),
        interval,
        metricnames: metricName,
        aggregation: normalizedAggregation,
      }),
    );

    return (result.value ?? []).flatMap((metric) =>
      (metric.timeseries ?? []).flatMap((series) =>
        (series.data ?? []).map((point) => ({
          resourceId,
          metricName: metric.name?.value ?? metricName,
          value: point.average ?? point.total ?? 0,
          unit: metric.unit ?? 'Count',
          timestamp: (point.timestamp instanceof Date ? point.timestamp : new Date(point.timestamp ?? Date.now())).toISOString(),
        } satisfies ResourceMetric)),
      ),
    );
  }

  private normalizeResource(resource: ResourceLike, fallbackType: string): Resource {
    return {
      id: resource.id ?? `${fallbackType}/${resource.name ?? 'unknown'}`,
      name: resource.name ?? 'unknown',
      type: resource.type ?? fallbackType,
      resourceGroup: resourceGroupFromId(resource.id ?? ''),
      location: resource.location ?? 'global',
      sku: resource.sku?.name ?? 'standard',
      tags: resource.tags ?? {},
      status: String(Reflect.get(resource.properties ?? {}, 'provisioningState') ?? 'unknown'),
    };
  }

  private buildIdleResource(
    resource: Resource,
    reason: string,
    metrics: ResourceMetric[],
    idleScore: number,
    estimatedMonthlySavings: number,
  ): IdleResource {
    return IdleResourceSchema.parse({
      resource,
      reason,
      idleScore,
      estimatedMonthlySavings,
      metrics,
    });
  }

  private metricAverage(metrics: ResourceMetric[]): number {
    if (metrics.length === 0) {
      return 0;
    }

    const total = metrics.reduce((sum, metric) => sum + metric.value, 0);
    return total / metrics.length;
  }

  private buildTimespan(days: number): string {
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return `${start.toISOString()}/${end.toISOString()}`;
  }
}
