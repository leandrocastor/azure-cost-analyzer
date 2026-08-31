import { PricingService } from '@/services/pricing';
import { ResourceDetectorService } from '@/services/resource-detector';
import { AzureApiError } from '@/utils/errors';

const metricsListMock = vi.fn();
const vmListAllMock = vi.fn();
const disksListMock = vi.fn();
const webAppsListMock = vi.fn();
const appServicePlansListMock = vi.fn();
const appServicePlansListWebAppsMock = vi.fn();
const storageListMock = vi.fn();
const sqlServersListMock = vi.fn();
const sqlDatabasesListByServerMock = vi.fn();
const publicIpListAllMock = vi.fn();
const loadBalancersListAllMock = vi.fn();

vi.mock('@azure/arm-monitor', () => ({
  MonitorClient: vi.fn(function () {
    return { metrics: { list: metricsListMock } };
  }),
}));
vi.mock('@azure/arm-compute', () => ({
  ComputeManagementClient: vi.fn(function () {
    return {
      virtualMachines: { listAll: vmListAllMock },
      disks: { list: disksListMock },
    };
  }),
}));
vi.mock('@azure/arm-network', () => ({
  NetworkManagementClient: vi.fn(function () {
    return {
      publicIPAddresses: { listAll: publicIpListAllMock },
      loadBalancers: { listAll: loadBalancersListAllMock },
    };
  }),
}));
vi.mock('@azure/arm-storage', () => ({
  StorageManagementClient: vi.fn(function () {
    return { storageAccounts: { list: storageListMock } };
  }),
}));
vi.mock('@azure/arm-sql', () => ({
  SqlManagementClient: vi.fn(function () {
    return {
      servers: { list: sqlServersListMock },
      databases: { listByServer: sqlDatabasesListByServerMock },
    };
  }),
}));
vi.mock('@azure/arm-appservice', () => ({
  WebSiteManagementClient: vi.fn(function () {
    return { webApps: { list: webAppsListMock }, appServicePlans: { list: appServicePlansListMock, listWebApps: appServicePlansListWebAppsMock } };
  }),
}));

const priceFetchMock = vi.fn();

/** Keeps the detector offline: pricing is an enrichment, not the subject of these tests. */
const offlinePricing = (): PricingService => new PricingService({ fetchImpl: priceFetchMock as never });

/**
 * Builds a metric series with enough samples to clear the minimum evidence bar.
 * A single point is treated as "never measured" and no longer yields a finding.
 */
const series = (metricName: string, value: number, key: 'average' | 'total' = 'average', points = 5): unknown => ({
  value: [
    {
      name: { value: metricName },
      unit: 'Count',
      timeseries: [
        {
          data: Array.from({ length: points }, (_, index) => ({
            [key]: value,
            timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          })),
        },
      ],
    },
  ],
});

const iterable = <T>(items: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: async function* generator() {
    for (const item of items) {
      yield item;
    }
  },
});

describe('ResourceDetectorService', () => {
  const azureClient = {
    getCredential: vi.fn(() => ({ token: 'credential' })),
    getSubscriptionId: vi.fn(() => 'sub-id'),
    executeWithRetry: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  };

  beforeEach(() => {
    metricsListMock.mockReset();
    vmListAllMock.mockReset();
    disksListMock.mockReset();
    webAppsListMock.mockReset();
    appServicePlansListMock.mockReset();
    appServicePlansListMock.mockReturnValue(iterable([]));
    appServicePlansListWebAppsMock.mockReset();
    appServicePlansListWebAppsMock.mockReturnValue(iterable([]));
    storageListMock.mockReset();
    sqlServersListMock.mockReset();
    sqlDatabasesListByServerMock.mockReset();
    publicIpListAllMock.mockReset();
    loadBalancersListAllMock.mockReset();
    priceFetchMock.mockReset();
    priceFetchMock.mockResolvedValue({ ok: true, json: async () => ({ Items: [] }) });
  });

  it('detects idle VMs', async () => {
    vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', hardwareProfile: { vmSize: 'Standard_D2s_v3' }, provisioningState: 'Succeeded' }]));
    metricsListMock.mockResolvedValue(series('Percentage CPU', 1));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleVMs();
    expect(items).toHaveLength(1);
    expect(metricsListMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ aggregation: 'Average' }),
    );
  });

  it('detects idle app services', async () => {
    webAppsListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-a', name: 'app-a', location: 'eastus', sku: { tier: 'Standard' } }]));
    metricsListMock.mockResolvedValue(series('Requests', 50, 'total'));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleAppServices();
    expect(items).toHaveLength(1);
    expect(metricsListMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ aggregation: 'Total' }),
    );
  });

  it('detects idle storage accounts', async () => {
    storageListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Storage/storageAccounts/store-a', name: 'store-a', location: 'eastus' }]));
    metricsListMock.mockResolvedValue(series('Transactions', 0, 'total'));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleStorage();
    expect(items).toHaveLength(1);
  });

  it('detects idle SQL databases', async () => {
    sqlServersListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a', name: 'sql-a', location: 'eastus' }]));
    sqlDatabasesListByServerMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a/databases/db-a', name: 'db-a', location: 'eastus' }]));
    metricsListMock.mockResolvedValue(series('dtu_consumption_percent', 2));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleSqlDatabases();
    expect(items).toHaveLength(1);
  });

  it('detects unattached disks', async () => {
    disksListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a', name: 'disk-a', location: 'eastus', diskState: 'Unattached' }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnattachedDisks();
    expect(items).toHaveLength(1);
  });

  it('detects unused public IPs', async () => {
    publicIpListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/publicIPAddresses/ip-a', name: 'ip-a', location: 'eastus', sku: { name: 'Standard' } }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnusedPublicIPs();
    expect(items).toHaveLength(1);
  });

  it('detects unused load balancers', async () => {
    loadBalancersListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/loadBalancers/lb-a', name: 'lb-a', location: 'eastus', sku: { name: 'Standard' }, backendAddressPools: [] }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnusedLoadBalancers();
    expect(items).toHaveLength(1);
  });

  it('aggregates all detectors', async () => {
    vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', properties: {} }]));
    disksListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a', name: 'disk-a', location: 'eastus', diskState: 'Unattached' }]));
    webAppsListMock.mockReturnValue(iterable([]));
    appServicePlansListMock.mockReturnValue(iterable([]));
    storageListMock.mockReturnValue(iterable([]));
    sqlServersListMock.mockReturnValue(iterable([]));
    publicIpListAllMock.mockReturnValue(iterable([]));
    loadBalancersListAllMock.mockReturnValue(iterable([]));
    metricsListMock.mockResolvedValue(series('Percentage CPU', 1));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectAll();
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps detector errors', async () => {
    vmListAllMock.mockImplementation(() => { throw new Error('oops'); });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    await expect(service.detectIdleVMs()).rejects.toBeInstanceOf(AzureApiError);
  });

  it('detectAll isolates a failing detector instead of discarding every other finding', async () => {
    // App Service Plans throttles and exhausts its retries, but disks still succeed.
    appServicePlansListMock.mockImplementation(() => {
      throw new Error('Too many requests. Please retry.');
    });
    disksListMock.mockReturnValue(
      iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a', name: 'disk-a', location: 'eastus', diskState: 'Unattached' }]),
    );
    webAppsListMock.mockReturnValue(iterable([]));
    storageListMock.mockReturnValue(iterable([]));
    sqlServersListMock.mockReturnValue(iterable([]));
    publicIpListAllMock.mockReturnValue(iterable([]));
    loadBalancersListAllMock.mockReturnValue(iterable([]));
    vmListAllMock.mockReturnValue(iterable([]));

    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectAll();

    expect(items).toHaveLength(1);
    expect(items[0]?.resource.name).toBe('disk-a');
  });

  it.each([
    ['vm', 'Percentage CPU', 1],
    ['app', 'Requests', 50],
    ['storage', 'Transactions', 0],
  ])('normalizes metrics for %s detectors', async (kind, metricName, value) => {
    metricsListMock.mockResolvedValue(series(metricName, value));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());

    if (kind === 'vm') {
      vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', properties: {} }]));
      const items = await service.detectIdleVMs();
      expect(items[0]?.metrics[0]?.metricName).toBe(metricName);
      return;
    }

    if (kind === 'app') {
      webAppsListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-a', name: 'app-a', location: 'eastus', sku: { tier: 'Standard' } }]));
      const items = await service.detectIdleAppServices();
      expect(items[0]?.metrics[0]?.metricName).toBe(metricName);
      return;
    }

    storageListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Storage/storageAccounts/store-a', name: 'store-a', location: 'eastus' }]));
    const items = await service.detectIdleStorage();
    expect(items[0]?.metrics[0]?.metricName).toBe(metricName);
  });
  describe('evidence and pricing', () => {
    it('prices an unattached disk by the tier Azure derives from its size', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a',
            name: 'disk-a',
            location: 'brazilsouth',
            sku: { name: 'Premium_LRS' },
            diskState: 'Unattached',
            diskSizeGB: 128,
          },
        ]),
      );
      priceFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          Items: [{ retailPrice: 174.93, currencyCode: 'BRL', unitOfMeasure: '1/Month', meterName: 'P10 LRS Disk', armRegionName: 'brazilsouth' }],
        }),
      });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(items[0]?.estimatedMonthlySavings).toBe(174.93);
      expect(items[0]?.evidence?.savingsBasis).toBe('retail-price');
      expect(items[0]?.evidence?.confidence).toBe('high');
      // A 128 GB premium disk is billed as P10, not as its ARM SKU name.
      expect(String(priceFetchMock.mock.calls[0]?.[0])).toContain('P10+LRS+Disk');
    });

    it('rounds a disk up to the next billable tier', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-b',
            name: 'disk-b',
            location: 'brazilsouth',
            sku: { name: 'StandardSSD_ZRS' },
            diskState: 'Unattached',
            diskSizeGB: 700,
          },
        ]),
      );

      await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(String(priceFetchMock.mock.calls[0]?.[0])).toContain('E30+ZRS+Disk');
    });

    it('falls back to the coarse estimate when no meter matches', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-c',
            name: 'disk-c',
            location: 'brazilsouth',
            sku: { name: 'Premium_LRS' },
            diskState: 'Unattached',
            diskSizeGB: 128,
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(items[0]?.estimatedMonthlySavings).toBe(30);
      expect(items[0]?.evidence?.savingsBasis).toBe('heuristic');
      expect(items[0]?.evidence?.caveat).toBeDefined();
    });

    it('prices a public IP by its own meter and not by the prefix meter', async () => {
      publicIpListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/publicIPAddresses/ip-a',
            name: 'ip-a',
            location: 'brazilsouth',
            sku: { name: 'Standard' },
          },
        ]),
      );
      priceFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          Items: [
            { retailPrice: 0.0308, currencyCode: 'BRL', unitOfMeasure: '1 Hour', meterName: 'Standard Static IP Addresses', armRegionName: 'brazilsouth' },
            { retailPrice: 0.0257, currencyCode: 'BRL', unitOfMeasure: '1 Hour', meterName: 'Standard IPv4 Static Public IP', armRegionName: 'brazilsouth' },
          ],
        }),
      });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedPublicIPs();

      // "Standard Static IP Addresses" is an IP Prefix meter and would overstate it.
      expect(items[0]?.evidence?.savingsBasisDetail).toContain('Standard IPv4 Static Public IP');
    });

    it('records the observation window that supports a VM finding', async () => {
      vmListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a',
            name: 'vm-a',
            location: 'eastus',
            hardwareProfile: { vmSize: 'Standard_D2s_v3' },
            provisioningState: 'Succeeded',
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Percentage CPU', 1));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      expect(items[0]?.evidence?.observationWindowDays).toBeGreaterThan(0);
      expect(items[0]?.evidence?.dataPoints).toBe(5);
      expect(items[0]?.evidence?.metrics.length).toBeGreaterThan(0);
    });
  });
  describe('false positives', () => {
    it('does not call a disk orphaned when it belongs to a stopped VM', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-parada',
            name: 'disk-parada',
            location: 'eastus',
            sku: { name: 'Premium_LRS' },
            // Azure reports "Reserved" for a disk attached to a deallocated VM.
            diskState: 'Reserved',
            managedBy: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-parada',
            diskSizeGB: 128,
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(items).toHaveLength(0);
    });

    it('reads the disk owner from the flattened payload the SDK returns', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-anexado',
            name: 'disk-anexado',
            location: 'eastus',
            sku: { name: 'Premium_LRS' },
            // The SDK flattens ARM properties; reading only the nested envelope
            // reported every disk in the tenant as an orphan.
            managedBy: '/subscriptions/sub/providers/Microsoft.Compute/virtualMachines/vm-a',
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(items).toHaveLength(0);
    });

    it('keeps a disk that is being served through an active SAS', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-sas',
            name: 'disk-sas',
            location: 'eastus',
            sku: { name: 'Premium_LRS' },
            diskState: 'ActiveSAS',
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnattachedDisks();

      expect(items).toHaveLength(0);
    });

    it('does not advise stopping a VM that is already deallocated', async () => {
      vmListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-parada',
            name: 'vm-parada',
            location: 'eastus',
            hardwareProfile: { vmSize: 'Standard_D2s_v3' },
            instanceView: { statuses: [{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/deallocated' }] },
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Percentage CPU', 0));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      // A deallocated VM already costs nothing for compute.
      expect(items).toHaveLength(0);
    });

    it('does not claim a resource is idle when it was never measured', async () => {
      vmListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-nova',
            name: 'vm-nova',
            location: 'eastus',
            hardwareProfile: { vmSize: 'Standard_D2s_v3' },
            instanceView: { statuses: [{ code: 'PowerState/running' }] },
          },
        ]),
      );
      // No samples at all: a VM created today, or missing Monitoring Reader rights.
      metricsListMock.mockResolvedValue({ value: [] });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      expect(items).toHaveLength(0);
    });

    it('ignores a single stray sample that cannot support a conclusion', async () => {
      vmListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-b',
            name: 'vm-b',
            location: 'eastus',
            hardwareProfile: { vmSize: 'Standard_D2s_v3' },
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Percentage CPU', 1, 'average', 1));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      expect(items).toHaveLength(0);
    });

    it('prices a VM by the size in its hardware profile', async () => {
      vmListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-c',
            name: 'vm-c',
            location: 'brazilsouth',
            hardwareProfile: { vmSize: 'Standard_D2s_v3' },
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Percentage CPU', 1));

      await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      // VMs have no sku field, so reading sku.name labelled every VM "standard"
      // and no meter ever matched.
      expect(String(priceFetchMock.mock.calls[0]?.[0])).toContain('Standard_D2s_v3');
    });

    it('keeps a public IP that is consumed by a NAT gateway', async () => {
      publicIpListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/publicIPAddresses/ip-nat',
            name: 'ip-nat',
            location: 'eastus',
            sku: { name: 'Standard' },
            // A NAT gateway consumes the address without exposing an ipConfiguration.
            natGateway: { id: '/subscriptions/sub/natGateways/nat-a' },
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedPublicIPs();

      expect(items).toHaveLength(0);
    });

    it('ignores an unassociated Basic dynamic IP because it is not billed', async () => {
      publicIpListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/publicIPAddresses/ip-basic',
            name: 'ip-basic',
            location: 'eastus',
            sku: { name: 'Basic' },
            publicIPAllocationMethod: 'Dynamic',
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedPublicIPs();

      expect(items).toHaveLength(0);
    });

    it('ignores a Basic load balancer because it carries no charge', async () => {
      loadBalancersListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/loadBalancers/lb-basic',
            name: 'lb-basic',
            location: 'eastus',
            sku: { name: 'Basic' },
            backendAddressPools: [],
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedLoadBalancers();

      expect(items).toHaveLength(0);
    });

    it('keeps a load balancer whose pool still has members', async () => {
      loadBalancersListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/loadBalancers/lb-ativo',
            name: 'lb-ativo',
            location: 'eastus',
            sku: { name: 'Standard' },
            backendAddressPools: [{ backendIPConfigurations: [{ id: '/nic-a' }] }],
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedLoadBalancers();

      expect(items).toHaveLength(0);
    });

    it('flags a Standard load balancer whose pool is empty', async () => {
      loadBalancersListAllMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/loadBalancers/lb-vazio',
            name: 'lb-vazio',
            location: 'eastus',
            sku: { name: 'Standard' },
            backendAddressPools: [{ backendIPConfigurations: [] }],
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectUnusedLoadBalancers();

      expect(items).toHaveLength(1);
    });

    it('does not offer savings for an App Service on a free plan', async () => {
      webAppsListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-free',
            name: 'app-free',
            location: 'eastus',
            sku: { tier: 'Free' },
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Requests', 0, 'total'));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServices();

      expect(items).toHaveLength(0);
    });

    it.each([
      ['string form returned by the Site model', 'Free'],
      ['SKU name code', 'F1'],
      ['shared tier code', 'D1'],
      ['consumption tier code', 'Y1'],
      ['flex consumption code', 'FC1'],
      ['string with different casing', 'free'],
    ])('does not offer savings for an App Service billed at zero (%s)', async (_label, sku) => {
      webAppsListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-free',
            name: 'app-free',
            location: 'eastus',
            // The Site model exposes sku as a plain string, not as an object.
            sku,
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Requests', 0, 'total'));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServices();

      expect(items).toHaveLength(0);
    });

    it('still reports a paid App Service tier', async () => {
      webAppsListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-paid',
            name: 'app-paid',
            location: 'eastus',
            sku: 'Standard',
          },
        ]),
      );
      metricsListMock.mockResolvedValue(series('Requests', 0, 'total'));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServices();

      expect(items).toHaveLength(1);
    });

    it('flags a paid App Service Plan with zero apps as a confirmed orphan', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-empty',
            name: 'plan-empty',
            location: 'eastus',
            sku: { name: 'S1', tier: 'Standard' },
            numberOfSites: 0,
          },
        ]),
      );
      appServicePlansListWebAppsMock.mockReturnValue(iterable([]));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toContain('sem nenhum aplicativo');
      expect(items[0]?.evidence.dataPoints).toBe(0);
    });

    it('does not flag a plan as orphan when numberOfSites is stale but listWebApps confirms hosted apps', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-stale-metadata',
            name: 'plan-stale-metadata',
            location: 'eastus',
            sku: { name: 'S1', tier: 'Standard' },
            // Azure's numberOfSites counter is known to lag or read zero even
            // when apps are deployed; listWebApps below is the ground truth.
            numberOfSites: 0,
          },
        ]),
      );
      appServicePlansListWebAppsMock.mockReturnValue(iterable([{ name: 'app-1' }, { name: 'app-2' }]));
      metricsListMock.mockImplementation(async (_id: string, options: { metricnames?: string }) =>
        options.metricnames === 'CpuPercentage' ? series('CpuPercentage', 45) : series('MemoryPercentage', 60),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(0);
    });

    it('skips a plan when the app count cannot be confirmed via listWebApps', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-unverifiable',
            name: 'plan-unverifiable',
            location: 'eastus',
            sku: { name: 'S1', tier: 'Standard' },
            numberOfSites: 0,
          },
        ]),
      );
      appServicePlansListWebAppsMock.mockImplementation(() => {
        throw new Error('Forbidden');
      });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(0);
    });

    it('does not flag a Free tier plan with zero apps, which carries no reserved cost', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-free',
            name: 'plan-free',
            location: 'eastus',
            sku: { name: 'F1', tier: 'Free' },
            numberOfSites: 0,
          },
        ]),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(0);
    });

    it('flags a plan whose hosted apps are all consistently idle', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-underused',
            name: 'plan-underused',
            location: 'eastus',
            sku: { name: 'S1', tier: 'Standard' },
            numberOfSites: 2,
          },
        ]),
      );
      appServicePlansListWebAppsMock.mockReturnValue(iterable([{ name: 'app-1' }, { name: 'app-2' }]));
      metricsListMock.mockImplementation(async (_id: string, options: { metricnames?: string }) =>
        options.metricnames === 'CpuPercentage' ? series('CpuPercentage', 3) : series('MemoryPercentage', 15),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toContain('2 aplicativo');
    });

    it('does not flag a plan with healthy CPU usage even with few apps', async () => {
      appServicePlansListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/serverfarms/plan-healthy',
            name: 'plan-healthy',
            location: 'eastus',
            sku: { name: 'S1', tier: 'Standard' },
            numberOfSites: 1,
          },
        ]),
      );
      appServicePlansListWebAppsMock.mockReturnValue(iterable([{ name: 'app-1' }]));
      metricsListMock.mockImplementation(async (_id: string, options: { metricnames?: string }) =>
        options.metricnames === 'CpuPercentage' ? series('CpuPercentage', 45) : series('MemoryPercentage', 60),
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleAppServicePlans();

      expect(items).toHaveLength(0);
    });

    it('measures a vCore database by CPU when it reports no DTU', async () => {
      sqlServersListMock.mockReturnValue(
        iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a', name: 'sql-a', location: 'eastus' }]),
      );
      sqlDatabasesListByServerMock.mockReturnValue(
        iterable([
          { id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a/databases/db-vcore', name: 'db-vcore', location: 'eastus' },
        ]),
      );
      metricsListMock.mockImplementation(async (_id: string, options: { metricnames?: string }) =>
        options.metricnames === 'cpu_percent' ? series('cpu_percent', 2) : { value: [] },
      );

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleSqlDatabases();

      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toContain('CPU');
    });

    it('skips the master database, which Azure creates and does not bill', async () => {
      sqlServersListMock.mockReturnValue(
        iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a', name: 'sql-a', location: 'eastus' }]),
      );
      sqlDatabasesListByServerMock.mockReturnValue(
        iterable([
          { id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a/databases/master', name: 'master', location: 'eastus' },
        ]),
      );
      metricsListMock.mockResolvedValue(series('dtu_consumption_percent', 0));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleSqlDatabases();

      expect(items).toHaveLength(0);
    });

    it('reports the provisioning state the SDK returns at the top level', async () => {
      disksListMock.mockReturnValue(
        iterable([
          {
            id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-d',
            name: 'disk-d',
            location: 'eastus',
            sku: { name: 'Premium_LRS' },
            diskState: 'Unattached',
            provisioningState: 'Succeeded',
          },
        ]),
      );

      const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
      await service.detectUnattachedDisks();

      expect(service.getInventory()[0]?.status).toBe('Succeeded');
    });
  });
  describe('stopped VMs with billed disks', () => {
    const stoppedVm = {
      id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-parada',
      name: 'vm-parada',
      location: 'brazilsouth',
      hardwareProfile: { vmSize: 'Standard_D2s_v3' },
      instanceView: { statuses: [{ code: 'PowerState/deallocated' }] },
      storageProfile: {
        osDisk: { managedDisk: { id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/os-disk' } },
        dataDisks: [{ managedDisk: { id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/data-disk' } }],
      },
    };

    const osDisk = {
      id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/os-disk',
      name: 'os-disk',
      location: 'brazilsouth',
      sku: { name: 'Premium_LRS' },
      diskState: 'Reserved',
      managedBy: stoppedVm.id,
      diskSizeGB: 128,
    };

    const dataDisk = { ...osDisk, id: stoppedVm.storageProfile.dataDisks[0]!.managedDisk.id, name: 'data-disk' };

    it('charges the disks that stay provisioned while the VM is off', async () => {
      vmListAllMock.mockReturnValue(iterable([stoppedVm]));
      disksListMock.mockReturnValue(iterable([osDisk, dataDisk]));
      priceFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          Items: [{ retailPrice: 174.93, currencyCode: 'BRL', unitOfMeasure: '1/Month', meterName: 'P10 LRS Disk', armRegionName: 'brazilsouth' }],
        }),
      });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectStoppedVMsWithBilledDisks();

      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toContain('desligada');
      // Two P10 disks, priced from the real meter rather than a flat guess.
      expect(items[0]?.estimatedMonthlySavings).toBe(349.86);
      expect(items[0]?.evidence?.savingsBasis).toBe('retail-price');
    });

    it('reports the provisioned storage as the evidence for the charge', async () => {
      vmListAllMock.mockReturnValue(iterable([stoppedVm]));
      disksListMock.mockReturnValue(iterable([osDisk, dataDisk]));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectStoppedVMsWithBilledDisks();

      const labels = items[0]?.evidence?.metrics.map((metric) => metric.label) ?? [];
      expect(labels).toContain('Discos anexados');
      expect(items[0]?.evidence?.metrics.find((metric) => metric.label === 'Armazenamento provisionado')?.value).toBe(256);
    });

    it('ignores a running VM', async () => {
      vmListAllMock.mockReturnValue(
        iterable([{ ...stoppedVm, instanceView: { statuses: [{ code: 'PowerState/running' }] } }]),
      );
      disksListMock.mockReturnValue(iterable([osDisk, dataDisk]));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectStoppedVMsWithBilledDisks();

      expect(items).toHaveLength(0);
    });

    it('does not query disks when nothing is deallocated', async () => {
      vmListAllMock.mockReturnValue(
        iterable([{ ...stoppedVm, instanceView: { statuses: [{ code: 'PowerState/running' }] } }]),
      );
      disksListMock.mockReturnValue(iterable([osDisk]));

      await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectStoppedVMsWithBilledDisks();

      expect(disksListMock).not.toHaveBeenCalled();
    });

    it('falls back to the coarse estimate when a disk cannot be priced', async () => {
      vmListAllMock.mockReturnValue(iterable([stoppedVm]));
      disksListMock.mockReturnValue(iterable([osDisk, { ...dataDisk, sku: { name: 'UltraSSD_LRS' }, diskSizeGB: 0 }]));

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectStoppedVMsWithBilledDisks();

      // A partial sum must never be presented as a precise figure.
      expect(items[0]?.evidence?.savingsBasis).toBe('heuristic');
      expect(items[0]?.evidence?.caveat).toBeDefined();
    });
  });
});
