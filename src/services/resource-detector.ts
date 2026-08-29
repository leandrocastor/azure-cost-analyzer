import { WebSiteManagementClient } from '@azure/arm-appservice';
import { ComputeManagementClient } from '@azure/arm-compute';
import { MonitorClient } from '@azure/arm-monitor';
import { NetworkManagementClient } from '@azure/arm-network';
import { SqlManagementClient } from '@azure/arm-sql';
import { StorageManagementClient } from '@azure/arm-storage';

import type { Confidence, Evidence, EvidenceMetric, IdleResource, Resource, ResourceMetric, SavingsBasis } from '@/models';
import { IdleResourceSchema } from '@/models';
import { AzureClientService } from '@/services/azure-client';
import type { PriceQuery } from '@/services/pricing';
import { PricingService } from '@/services/pricing';
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
  sku?: { name?: string; tier?: string };
  tags?: Record<string, string>;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Reads an ARM property regardless of where the payload places it.
 *
 * The Azure SDK for JS flattens the ARM "properties" envelope onto the resource
 * itself, so `disk.managedBy` is top level while the raw REST response nests it
 * under `disk.properties.managedBy`. Reading only the nested form silently yields
 * undefined for every resource, which turned every disk into a false orphan.
 */
const readProperty = <T>(resource: ResourceLike, key: string): T | undefined => {
  const flattened = resource[key];
  if (flattened !== undefined && flattened !== null) {
    return flattened as T;
  }

  const nested = resource.properties?.[key];
  return nested === undefined || nested === null ? undefined : (nested as T);
};

/**
 * A metric average of zero means "idle" only when there were samples to average.
 * An empty series means the resource was never measured, which happens for
 * resources created within the window, tiers that do not emit the metric, or
 * missing Monitoring Reader rights. Treating that silence as idleness is the
 * single largest source of false positives, so findings require real samples.
 */
const MIN_DATA_POINTS = 3;

/** Disk states in which the disk is in use even though no VM is running. */
const IN_USE_DISK_STATES = new Set(['attached', 'reserved', 'frozen', 'activesas', 'activesasfrozen', 'activeupload', 'readytoupload']);

/** App Service tiers that carry no compute charge, so there is nothing to save. */
const FREE_APP_SERVICE_TIERS = new Set(['free', 'shared', 'dynamic', 'flexconsumption']);

type ComputeClientLike = {
  virtualMachines: { listAll: (options?: Record<string, unknown>) => AsyncIterable<ResourceLike> | Iterable<ResourceLike> };
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
  private readonly inventory = new Map<string, Resource>();
  private readonly monitorClient: MonitorClientLike;
  private readonly computeClient: ComputeClientLike;
  private readonly networkClient: NetworkClientLike;
  private readonly storageClient: StorageClientLike;
  private readonly sqlClient: SqlClientLike;
  private readonly appServiceClient: AppServiceClientLike;

  public constructor(
    private readonly azureClient = new AzureClientService(),
    subscriptionIdOverride?: string,
    private readonly pricingService: PricingService = new PricingService(),
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
      // statusOnly brings the runtime power state in the same call. Without it a
      // stopped VM reports no CPU samples, which used to be read as "idle" and
      // priced as if stopping it would save the full compute charge.
      const vms = await toArray(this.computeClient.virtualMachines.listAll({ statusOnly: 'true' }));
      const idleResources: IdleResource[] = [];

      for (const vm of vms) {
        const resource = this.normalizeResource(vm, 'Microsoft.Compute/virtualMachines');
        const powerState = this.readPowerState(vm);

        if (powerState === 'deallocated') {
          // A deallocated VM already costs nothing for compute, so advising to stop
          // it is meaningless. The real waste is the disks it still holds.
          continue;
        }

        const metrics = await this.getMetrics(resource.id, 'Percentage CPU', 'PT1H', 'avg');
        if (metrics.length < MIN_DATA_POINTS) {
          continue;
        }

        const avgCpu = this.metricAverage(metrics);
        if (avgCpu < 5) {
          idleResources.push(
            await this.buildIdleResource({
              resource,
              reason: 'CPU média abaixo de 5% nos últimos 7 dias',
              metrics,
              idleScore: 92,
              fallbackMonthlySavings: 120,
              observationWindowDays: 7,
              evidenceMetrics: [
                { label: 'CPU média', value: Number(avgCpu.toFixed(2)), unit: '%', threshold: 5, comparison: 'below' },
                { label: 'CPU máxima', value: Number(this.metricMax(metrics).toFixed(2)), unit: '%' },
              ],
            }),
          );
        }
      }

      return idleResources;
    }, 'Failed to detect idle VMs');
  }

  /**
   * Extracts the runtime power state from the instance view status list, where it
   * appears as a code such as "PowerState/deallocated".
   */
  private readPowerState(vm: ResourceLike): string | undefined {
    const instanceView = readProperty<{ statuses?: { code?: string }[] }>(vm, 'instanceView');
    const statuses = instanceView?.statuses ?? [];

    for (const status of statuses) {
      const code = status.code ?? '';
      if (code.toLowerCase().startsWith('powerstate/')) {
        return code.slice('powerstate/'.length).toLowerCase();
      }
    }

    return undefined;
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

        // Free, Shared and Consumption plans carry no fixed compute charge, so
        // there is no monthly saving to claim by shutting the site down.
        const tier = String(app.sku?.tier ?? app.sku?.name ?? '').toLowerCase();
        if (FREE_APP_SERVICE_TIERS.has(tier)) {
          continue;
        }

        const metrics = await this.getMetrics(resource.id, 'Requests', 'P1D', 'sum');
        if (metrics.length < MIN_DATA_POINTS) {
          continue;
        }

        const dailyRequests = this.metricAverage(metrics);
        if (dailyRequests < 100) {
          idleResources.push(
            await this.buildIdleResource({
              resource,
              reason: 'Menos de 100 requisições por dia',
              metrics,
              idleScore: 78,
              fallbackMonthlySavings: 65,
              observationWindowDays: 30,
              evidenceMetrics: [
                { label: 'Requisições por dia', value: Number(dailyRequests.toFixed(2)), unit: 'req/dia', threshold: 100, comparison: 'below' },
              ],
            }),
          );
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
        if (metrics.length < MIN_DATA_POINTS) {
          continue;
        }

        const avgTransactions = this.metricAverage(metrics);
        if (avgTransactions === 0) {
          idleResources.push(
            await this.buildIdleResource({
              resource,
              reason: 'Sem transações de storage nos últimos 30 dias',
              metrics,
              idleScore: 85,
              fallbackMonthlySavings: 40,
              observationWindowDays: 30,
              evidenceMetrics: [
                { label: 'Transações', value: 0, unit: 'operações', threshold: 0, comparison: 'equals' },
              ],
            }),
          );
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

          // The master database is metadata created by Azure and carries no charge.
          if (resource.name.toLowerCase() === 'master') {
            continue;
          }

          // Only DTU-based databases emit dtu_consumption_percent; the vCore model
          // reports cpu_percent instead. Reading just the former left every vCore
          // database with an empty series, which used to be scored as idle.
          const usage = await this.readSqlUsage(resource.id);
          if (!usage || usage.metrics.length < MIN_DATA_POINTS) {
            continue;
          }

          if (usage.average < 5) {
            idleResources.push(
              await this.buildIdleResource({
                resource,
                reason: `Consumo de ${usage.label} abaixo de 5%`,
                metrics: usage.metrics,
                idleScore: 80,
                fallbackMonthlySavings: 90,
                observationWindowDays: 7,
                evidenceMetrics: [
                  { label: `${usage.label} médio`, value: Number(usage.average.toFixed(2)), unit: '%', threshold: 5, comparison: 'below' },
                ],
              }),
            );
          }
        }
      }

      return idleResources;
    }, 'Failed to detect idle SQL databases');
  }

  /**
   * Detects deallocated VMs whose disks keep being billed.
   *
   * Stopping a VM removes the compute charge but not the storage one, so a machine
   * that has been off for months still costs money every day. This is the finding
   * that replaces the old, incorrect one where the same disks were reported as
   * orphaned even though they belong to a VM the customer intends to start again.
   */
  public async detectStoppedVMsWithBilledDisks(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const vms = await toArray(this.computeClient.virtualMachines.listAll({ statusOnly: 'true' }));
      const stopped = vms.filter((vm) => this.readPowerState(vm) === 'deallocated');

      if (stopped.length === 0) {
        return [];
      }

      const disksById = new Map(
        (await toArray(this.computeClient.disks.list())).map((disk) => [String(disk.id ?? '').toLowerCase(), disk]),
      );

      const findings: IdleResource[] = [];

      for (const vm of stopped) {
        const resource = this.normalizeResource(vm, 'Microsoft.Compute/virtualMachines');
        const disks = this.attachedDiskIds(vm)
          .map((id) => disksById.get(id.toLowerCase()))
          .filter((disk): disk is ResourceLike => disk !== undefined);

        if (disks.length === 0) {
          continue;
        }

        const monthlyCost = await this.sumDiskMonthlyCost(disks);
        const totalGb = disks.reduce((sum, disk) => sum + Number(readProperty<number>(disk, 'diskSizeGB') ?? 0), 0);

        findings.push(
          await this.buildIdleResource({
            resource,
            reason: 'VM desligada (deallocated), mas os discos continuam sendo cobrados',
            metrics: [],
            idleScore: 90,
            fallbackMonthlySavings: monthlyCost ?? 30 * disks.length,
            observationWindowDays: 0,
            evidenceMetrics: [
              { label: 'Discos anexados', value: disks.length, unit: 'discos' },
              { label: 'Armazenamento provisionado', value: totalGb, unit: 'GB' },
            ],
            ...(monthlyCost === undefined
              ? {}
              : {
                  savingsOverride: {
                    amount: monthlyCost,
                    detail: `Soma do preço de lista dos ${disks.length} disco(s) que permanecem provisionados enquanto a VM está desligada.`,
                  },
                }),
          }),
        );
      }

      return findings;
    }, 'Failed to detect stopped VMs with billed disks');
  }

  /** Collects the managed disk IDs referenced by the VM storage profile. */
  private attachedDiskIds(vm: ResourceLike): string[] {
    const profile = readProperty<{
      osDisk?: { managedDisk?: { id?: string } };
      dataDisks?: { managedDisk?: { id?: string } }[];
    }>(vm, 'storageProfile');

    const ids = [profile?.osDisk?.managedDisk?.id, ...(profile?.dataDisks ?? []).map((disk) => disk.managedDisk?.id)];

    return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /**
   * Adds up the list price of the given disks. Returns undefined when any of them
   * cannot be priced, so a partial sum is never presented as a precise figure.
   */
  private async sumDiskMonthlyCost(disks: ResourceLike[]): Promise<number | undefined> {
    let total = 0;

    for (const disk of disks) {
      const resource = this.toResource(disk, 'Microsoft.Compute/disks');
      const sizeGb = Number(readProperty<number>(disk, 'diskSizeGB') ?? 0);
      const query = this.buildDiskPriceQuery(resource, sizeGb);
      const price = query ? await this.pricingService.getMonthlyPrice(query) : undefined;

      if (!price) {
        return undefined;
      }

      total += price.amount;
    }

    return Number(total.toFixed(2));
  }

  /**
   * Reads database utilization across both purchasing models, preferring whichever
   * one actually reported samples.
   */
  private async readSqlUsage(resourceId: string): Promise<{ metrics: ResourceMetric[]; average: number; label: string } | undefined> {
    const candidates: { metric: string; label: string }[] = [
      { metric: 'dtu_consumption_percent', label: 'DTU' },
      { metric: 'cpu_percent', label: 'CPU' },
    ];

    for (const candidate of candidates) {
      const metrics = await this.getMetrics(resourceId, candidate.metric, 'PT1H', 'avg');
      if (metrics.length >= MIN_DATA_POINTS) {
        return { metrics, average: this.metricAverage(metrics), label: candidate.label };
      }
    }

    return undefined;
  }

  /**
   * Detects unattached managed disks.
   */
  public async detectUnattachedDisks(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const disks = await toArray(this.computeClient.disks.list());
      // Every disk is normalized so the inventory reflects the whole estate, not
      // only the orphans, which would bias governance metrics such as tag coverage.
      const normalized = disks.map((disk) => ({ disk, resource: this.normalizeResource(disk, 'Microsoft.Compute/disks') }));
      const unattached = normalized.filter(({ disk }) => this.isOrphanedDisk(disk));

      return Promise.all(
        unattached.map(async ({ disk, resource }) => {
          const sizeGb = Number(readProperty<number>(disk, 'diskSizeGB') ?? 0);

          return this.buildIdleResource({
            resource,
            reason: 'Disco não está anexado a nenhuma VM',
            metrics: [],
            idleScore: 95,
            fallbackMonthlySavings: 30,
            observationWindowDays: 0,
            evidenceMetrics: sizeGb > 0 ? [{ label: 'Tamanho do disco', value: sizeGb, unit: 'GB' }] : [],
            priceQuery: this.buildDiskPriceQuery(resource, sizeGb),
          });
        }),
      );
    }, 'Failed to detect unattached disks');
  }

  /**
   * A disk is only orphaned when Azure itself reports it as Unattached.
   *
   * `managedBy` alone is not enough: a disk attached to a stopped-deallocated VM
   * keeps its owner and is reported by Azure as "Reserved", not "Unattached".
   * Deleting it would destroy a machine the customer intends to start again, so
   * every in-use state is excluded even when no VM is currently running.
   */
  private isOrphanedDisk(disk: ResourceLike): boolean {
    if (readProperty<string>(disk, 'managedBy')) {
      return false;
    }

    const attachedToMany = readProperty<string[]>(disk, 'managedByExtended') ?? [];
    if (attachedToMany.length > 0) {
      return false;
    }

    const diskState = readProperty<string>(disk, 'diskState');
    if (diskState) {
      return !IN_USE_DISK_STATES.has(diskState.toLowerCase());
    }

    // Without a reported state, the absence of an owner is the only evidence left.
    return true;
  }

  /**
   * Detects public IPs that are not associated with resources.
   */
  public async detectUnusedPublicIPs(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const ips = await toArray(this.networkClient.publicIPAddresses.listAll());
      const normalized = ips.map((ip) => ({ ip, resource: this.normalizeResource(ip, 'Microsoft.Network/publicIPAddresses') }));
      const unused = normalized.filter(({ ip }) => this.isUnusedPublicIp(ip));

      return Promise.all(
        unused.map(async ({ resource }) =>
          this.buildIdleResource({
            resource,
            reason: 'Public IP não está associado a nenhum recurso',
            metrics: [],
            idleScore: 88,
            fallbackMonthlySavings: 15,
            observationWindowDays: 0,
          }),
        ),
      );
    }, 'Failed to detect unused public IPs');
  }

  /**
   * Detects load balancers with no backend pool associations.
   */
  public async detectUnusedLoadBalancers(): Promise<IdleResource[]> {
    return this.wrapDetection(async () => {
      const loadBalancers = await toArray(this.networkClient.loadBalancers.listAll());
      const normalized = loadBalancers.map((lb) => ({ lb, resource: this.normalizeResource(lb, 'Microsoft.Network/loadBalancers') }));
      const unused = normalized.filter(({ lb }) => this.isUnusedLoadBalancer(lb));

      return Promise.all(
        unused.map(async ({ resource }) =>
          this.buildIdleResource({
            resource,
            reason: 'Load balancer sem backend pools configurados',
            metrics: [],
            idleScore: 84,
            fallbackMonthlySavings: 25,
            observationWindowDays: 0,
          }),
        ),
      );
    }, 'Failed to detect unused load balancers');
  }

  /**
   * A public IP is only wasted when nothing points at it.
   *
   * Besides NIC associations, an address can be consumed by a NAT Gateway or be
   * carved out of a Public IP Prefix, and in neither case does it expose an
   * ipConfiguration. Flagging those would recommend deleting an address that a
   * gateway depends on. A Basic dynamic address is also excluded because Azure
   * only assigns and bills it once it is attached.
   */
  private isUnusedPublicIp(ip: ResourceLike): boolean {
    if (readProperty<unknown>(ip, 'ipConfiguration')) {
      return false;
    }

    if (readProperty<unknown>(ip, 'natGateway') || readProperty<unknown>(ip, 'publicIPPrefix')) {
      return false;
    }

    const allocation = String(readProperty<string>(ip, 'publicIPAllocationMethod') ?? '').toLowerCase();
    const tier = String(ip.sku?.name ?? '').toLowerCase();

    return !(tier === 'basic' && allocation === 'dynamic');
  }

  /**
   * A load balancer is only wasted when it is billed and carries no traffic path.
   *
   * Basic load balancers are free, so recommending their removal produces savings
   * that do not exist. A Standard balancer with a backend pool that has no members
   * is just as idle as one with no pool at all, so membership is what is measured.
   */
  private isUnusedLoadBalancer(lb: ResourceLike): boolean {
    const tier = String(lb.sku?.name ?? '').toLowerCase();
    if (tier === 'basic') {
      return false;
    }

    const pools = readProperty<{ backendIPConfigurations?: unknown[]; loadBalancerBackendAddresses?: unknown[] }[]>(lb, 'backendAddressPools') ?? [];
    if (pools.length === 0) {
      return true;
    }

    return pools.every(
      (pool) => (pool.backendIPConfigurations?.length ?? 0) === 0 && (pool.loadBalancerBackendAddresses?.length ?? 0) === 0,
    );
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
      this.detectStoppedVMsWithBilledDisks(),
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

  /**
   * Every resource seen during detection, including healthy ones. Governance checks
   * such as tag coverage must consider the whole estate: measuring only the idle
   * resources would report a coverage figure for a biased sample.
   */
  public getInventory(): Resource[] {
    return Array.from(this.inventory.values());
  }

  private normalizeResource(resource: ResourceLike, fallbackType: string): Resource {
    const normalized = this.toResource(resource, fallbackType);
    this.inventory.set(normalized.id, normalized);
    return normalized;
  }

  private toResource(resource: ResourceLike, fallbackType: string): Resource {
    return {
      id: resource.id ?? `${fallbackType}/${resource.name ?? 'unknown'}`,
      name: resource.name ?? 'unknown',
      type: resource.type ?? fallbackType,
      resourceGroup: resourceGroupFromId(resource.id ?? ''),
      location: resource.location ?? 'global',
      sku: this.readSku(resource),
      tags: resource.tags ?? {},
      status: String(readProperty<string>(resource, 'provisioningState') ?? 'unknown'),
    };
  }

  /**
   * Resolves the SKU that identifies the resource in the price catalog.
   *
   * Virtual machines carry no `sku` field: their size lives in the hardware
   * profile. Reading only `sku.name` labelled every VM as "standard", which never
   * matches a meter and silently pushed every VM back to the coarse estimate.
   */
  private readSku(resource: ResourceLike): string {
    const vmSize = readProperty<{ vmSize?: string }>(resource, 'hardwareProfile')?.vmSize;
    return vmSize ?? resource.sku?.name ?? 'standard';
  }

  /**
   * Builds a finding with a savings figure backed by the real Azure list price
   * whenever it can be resolved, plus the evidence that supports the claim.
   *
   * The fallback amount is only a last resort: it is a coarse average that cannot
   * distinguish a B1s from an M128ms, so findings that rely on it are explicitly
   * marked as low confidence instead of being presented as precise numbers.
   */
  private async buildIdleResource(options: {
    resource: Resource;
    reason: string;
    metrics: ResourceMetric[];
    idleScore: number;
    fallbackMonthlySavings: number;
    observationWindowDays: number;
    evidenceMetrics?: EvidenceMetric[];
    priceQuery?: PriceQuery | undefined;
    /** Savings already resolved by the caller, e.g. the sum of several meters. */
    savingsOverride?: { amount: number; detail: string } | undefined;
  }): Promise<IdleResource> {
    const pricing = options.savingsOverride
      ? { amount: options.savingsOverride.amount, basis: 'retail-price' as SavingsBasis, detail: options.savingsOverride.detail }
      : await this.resolveMonthlySavings(options.resource, options.fallbackMonthlySavings, options.priceQuery);
    const evidenceMetrics = options.evidenceMetrics ?? [];
    const confidence = this.resolveConfidence(pricing.basis, options.metrics.length, evidenceMetrics.length);

    const evidence: Evidence = {
      observationWindowDays: options.observationWindowDays,
      dataPoints: options.metrics.length,
      metrics: evidenceMetrics,
      savingsBasis: pricing.basis,
      savingsBasisDetail: pricing.detail,
      confidence,
      ...(pricing.basis === 'heuristic'
        ? { caveat: 'Preço de lista indisponível para esta SKU/região; valor aproximado por média de mercado.' }
        : {}),
    };

    return IdleResourceSchema.parse({
      resource: options.resource,
      reason: options.reason,
      idleScore: options.idleScore,
      estimatedMonthlySavings: pricing.amount,
      metrics: options.metrics,
      evidence,
    });
  }

  /**
   * A finding is only as trustworthy as the data behind it: a real price plus
   * observed metrics is high confidence, while a fallback price with no telemetry
   * is explicitly flagged as low.
   */
  private resolveConfidence(basis: SavingsBasis, dataPoints: number, evidenceCount: number): Confidence {
    if (basis === 'heuristic') {
      return dataPoints > 0 ? 'medium' : 'low';
    }

    // Configuration-based findings (an unattached disk) need no telemetry to be certain.
    if (dataPoints > 0 || evidenceCount > 0) {
      return 'high';
    }

    return 'medium';
  }

  /**
   * Resolves the monthly list price for the resource, falling back to the coarse
   * estimate when the SKU or region has no matching meter.
   */
  private async resolveMonthlySavings(
    resource: Resource,
    fallback: number,
    priceQuery?: PriceQuery,
  ): Promise<{ amount: number; basis: SavingsBasis; detail: string }> {
    const query = priceQuery ?? this.buildPriceQuery(resource);

    if (query) {
      const price = await this.pricingService.getMonthlyPrice(query);
      if (price) {
        return {
          amount: price.amount,
          basis: 'retail-price',
          detail: `Preço de lista Azure para ${price.meterName} em ${price.region} (${price.currency}, ${price.unitOfMeasure}), projetado para 730 horas/mês.`,
        };
      }
    }

    return {
      amount: fallback,
      basis: 'heuristic',
      detail: 'Estimativa média por tipo de recurso, usada quando o preço de lista não pôde ser consultado.',
    };
  }

  /**
   * Maps a resource to the Retail Prices catalog. Services whose cost depends on
   * consumption rather than on an allocated SKU are intentionally left out, since a
   * list price alone would not represent their real spend.
   */
  private buildPriceQuery(resource: Resource): PriceQuery | undefined {
    const region = resource.location;
    if (!region || region === 'global') {
      return undefined;
    }

    switch (resource.type.toLowerCase()) {
      case 'microsoft.compute/virtualmachines':
        return { serviceName: 'Virtual Machines', region, armSkuName: resource.sku };
      case 'microsoft.network/publicipaddresses':
        return { serviceName: 'Virtual Network', region, meterNamePattern: this.publicIpMeterPattern(resource.sku) };
      default:
        // Managed disks are priced through buildDiskPriceQuery, which needs the disk
        // size. Load balancers have no per-instance meter in the retail catalog, so
        // they intentionally stay on the heuristic instead of borrowing a wrong meter.
        return undefined;
    }
  }

  /**
   * The retail catalog exposes one meter per public IP tier, plus a similarly named
   * meter for IP Prefixes that must not be picked up: charging an orphaned address at
   * prefix rates would overstate the saving.
   */
  private publicIpMeterPattern(sku: string): RegExp {
    return /standard/i.test(sku) ? /^Standard IPv4 .*Public IP$/i : /^Basic IPv4 .*Public IP$/i;
  }

  /**
   * Managed disks are not billed by their ARM SKU but by the performance tier that
   * Azure derives from the provisioned size, so the price of an orphaned disk can
   * only be resolved by mapping size plus family back to that tier (P10, E20, S30).
   */
  private buildDiskPriceQuery(resource: Resource, sizeGb: number): PriceQuery | undefined {
    const region = resource.location;
    if (!region || region === 'global' || sizeGb <= 0) {
      return undefined;
    }

    const sku = resource.sku.toLowerCase();
    const family = sku.startsWith('premium_') ? 'P' : sku.startsWith('standardssd_') ? 'E' : sku.startsWith('standard_') ? 'S' : undefined;
    if (!family) {
      return undefined;
    }

    const tier = this.resolveDiskTier(family, sizeGb);
    if (!tier) {
      return undefined;
    }

    const redundancy = sku.endsWith('_zrs') ? 'ZRS' : 'LRS';
    // Exact name on purpose: "E20 ZRS Disk Mount" is the mount fee, not the disk.
    return { serviceName: 'Storage', region, meterName: `${tier} ${redundancy} Disk` };
  }

  /**
   * Azure rounds a disk up to the next standard size, so a 700 GB disk is billed as
   * the 1024 GB tier. Sizes above the largest tier have no matching meter.
   */
  private resolveDiskTier(family: 'P' | 'E' | 'S', sizeGb: number): string | undefined {
    const tiers: { index: number; sizeGb: number }[] = [
      { index: 1, sizeGb: 4 },
      { index: 2, sizeGb: 8 },
      { index: 3, sizeGb: 16 },
      { index: 4, sizeGb: 32 },
      { index: 6, sizeGb: 64 },
      { index: 10, sizeGb: 128 },
      { index: 15, sizeGb: 256 },
      { index: 20, sizeGb: 512 },
      { index: 30, sizeGb: 1024 },
      { index: 40, sizeGb: 2048 },
      { index: 50, sizeGb: 4096 },
      { index: 60, sizeGb: 8192 },
      { index: 70, sizeGb: 16384 },
      { index: 80, sizeGb: 32767 },
    ];

    // Standard HDD has no tiers below S4, and its smallest billed size is 32 GB.
    const eligible = tiers.filter((tier) => (family === 'S' ? tier.index >= 4 : true));
    const match = eligible.find((tier) => sizeGb <= tier.sizeGb);

    return match ? `${family}${match.index}` : undefined;
  }

  private metricMax(metrics: ResourceMetric[]): number {
    return metrics.reduce((max, metric) => Math.max(max, metric.value), 0);
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
