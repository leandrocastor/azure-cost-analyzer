import { PricingService } from '@/services/pricing';
import { ResourceDetectorService } from '@/services/resource-detector';
import { AzureApiError } from '@/utils/errors';

const metricsListMock = vi.fn();
const vmListAllMock = vi.fn();
const disksListMock = vi.fn();
const webAppsListMock = vi.fn();
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
    return { webApps: { list: webAppsListMock } };
  }),
}));

const priceFetchMock = vi.fn();

/** Keeps the detector offline: pricing is an enrichment, not the subject of these tests. */
const offlinePricing = (): PricingService => new PricingService({ fetchImpl: priceFetchMock as never });

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
    storageListMock.mockReset();
    sqlServersListMock.mockReset();
    sqlDatabasesListByServerMock.mockReset();
    publicIpListAllMock.mockReset();
    loadBalancersListAllMock.mockReset();
    priceFetchMock.mockReset();
    priceFetchMock.mockResolvedValue({ ok: true, json: async () => ({ Items: [] }) });
  });

  it('detects idle VMs', async () => {
    vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', sku: { name: 'Standard' }, properties: { provisioningState: 'Succeeded' } }]));
    metricsListMock.mockResolvedValue({ value: [{ name: { value: 'Percentage CPU' }, unit: 'Percent', timeseries: [{ data: [{ average: 1, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleVMs();
    expect(items).toHaveLength(1);
    expect(metricsListMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ aggregation: 'Average' }),
    );
  });

  it('detects idle app services', async () => {
    webAppsListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-a', name: 'app-a', location: 'eastus' }]));
    metricsListMock.mockResolvedValue({ value: [{ name: { value: 'Requests' }, unit: 'Count', timeseries: [{ data: [{ total: 50, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
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
    metricsListMock.mockResolvedValue({ value: [{ name: { value: 'Transactions' }, unit: 'Count', timeseries: [{ data: [{ total: 0, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleStorage();
    expect(items).toHaveLength(1);
  });

  it('detects idle SQL databases', async () => {
    sqlServersListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a', name: 'sql-a', location: 'eastus' }]));
    sqlDatabasesListByServerMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sql-a/databases/db-a', name: 'db-a', location: 'eastus' }]));
    metricsListMock.mockResolvedValue({ value: [{ name: { value: 'dtu_consumption_percent' }, unit: 'Percent', timeseries: [{ data: [{ average: 2, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectIdleSqlDatabases();
    expect(items).toHaveLength(1);
  });

  it('detects unattached disks', async () => {
    disksListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a', name: 'disk-a', location: 'eastus', properties: {} }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnattachedDisks();
    expect(items).toHaveLength(1);
  });

  it('detects unused public IPs', async () => {
    publicIpListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/publicIPAddresses/ip-a', name: 'ip-a', location: 'eastus', properties: {} }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnusedPublicIPs();
    expect(items).toHaveLength(1);
  });

  it('detects unused load balancers', async () => {
    loadBalancersListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/loadBalancers/lb-a', name: 'lb-a', location: 'eastus', properties: { backendAddressPools: [] } }]));
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectUnusedLoadBalancers();
    expect(items).toHaveLength(1);
  });

  it('aggregates all detectors', async () => {
    vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', properties: {} }]));
    disksListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a', name: 'disk-a', location: 'eastus', properties: {} }]));
    webAppsListMock.mockReturnValue(iterable([]));
    storageListMock.mockReturnValue(iterable([]));
    sqlServersListMock.mockReturnValue(iterable([]));
    publicIpListAllMock.mockReturnValue(iterable([]));
    loadBalancersListAllMock.mockReturnValue(iterable([]));
    metricsListMock.mockResolvedValue({ value: [{ name: { value: 'Percentage CPU' }, unit: 'Percent', timeseries: [{ data: [{ average: 1, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    const items = await service.detectAll();
    expect(items.length).toBeGreaterThanOrEqual(2);
  });

  it('wraps detector errors', async () => {
    vmListAllMock.mockImplementation(() => { throw new Error('oops'); });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());
    await expect(service.detectIdleVMs()).rejects.toBeInstanceOf(AzureApiError);
  });

  it.each([
    ['vm', 'Percentage CPU', 1],
    ['app', 'Requests', 50],
    ['storage', 'Transactions', 0],
  ])('normalizes metrics for %s detectors', async (kind, metricName, value) => {
    metricsListMock.mockResolvedValue({ value: [{ name: { value: metricName }, unit: 'Count', timeseries: [{ data: [{ average: value, timestamp: '2026-01-01T00:00:00.000Z' }] }] }] });
    const service = new ResourceDetectorService(azureClient as never, undefined, offlinePricing());

    if (kind === 'vm') {
      vmListAllMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a', name: 'vm-a', location: 'eastus', properties: {} }]));
      const items = await service.detectIdleVMs();
      expect(items[0]?.metrics[0]?.metricName).toBe(metricName);
      return;
    }

    if (kind === 'app') {
      webAppsListMock.mockReturnValue(iterable([{ id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Web/sites/app-a', name: 'app-a', location: 'eastus' }]));
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
            properties: { diskSizeGB: 128 },
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
            properties: { diskSizeGB: 700 },
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
            properties: { diskSizeGB: 128 },
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
            properties: {},
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
            sku: { name: 'Standard_D2s_v3' },
            properties: { provisioningState: 'Succeeded' },
          },
        ]),
      );
      metricsListMock.mockResolvedValue({
        value: [{ name: { value: 'Percentage CPU' }, unit: 'Percent', timeseries: [{ data: [{ average: 1, timestamp: '2026-01-01T00:00:00.000Z' }] }] }],
      });

      const items = await new ResourceDetectorService(azureClient as never, undefined, offlinePricing()).detectIdleVMs();

      expect(items[0]?.evidence?.observationWindowDays).toBeGreaterThan(0);
      expect(items[0]?.evidence?.dataPoints).toBe(1);
      expect(items[0]?.evidence?.metrics.length).toBeGreaterThan(0);
    });
  });
});
