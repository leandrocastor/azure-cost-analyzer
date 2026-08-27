import { CostManagementClient } from '@azure/arm-costmanagement';

import { CostAnalyzerService } from '@/services/cost-analyzer';
import { AzureApiError } from '@/utils/errors';
import { mockCostEntries } from '../fixtures/mock-data';

const usageMock = vi.fn();

vi.mock('@azure/arm-costmanagement', () => ({
  CostManagementClient: vi.fn(function () {
    return {
      query: {
        usage: usageMock,
      },
    };
  }),
}));

describe('CostAnalyzerService', () => {
  const azureClient = {
    getCredential: vi.fn(() => ({ token: 'credential' })),
    getSubscriptionId: vi.fn(() => '11111111-1111-1111-1111-111111111111'),
    executeWithRetry: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  };

  beforeEach(() => {
    usageMock.mockReset();
    azureClient.getCredential.mockClear();
    azureClient.getSubscriptionId.mockClear();
    azureClient.executeWithRetry.mockClear();
  });

  it('queries summarized costs', async () => {
    usageMock.mockResolvedValue({
      columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }, { name: 'Currency' }, { name: 'ServiceName' }, { name: 'ResourceGroup' }, { name: 'ResourceLocation' }],
      rows: [
        [100, '2026-01-01', 'USD', 'Compute', 'rg-a', 'eastus'],
        [50, '2026-01-02', 'USD', 'Storage', 'rg-b', 'westus'],
      ],
    });
    const service = new CostAnalyzerService(azureClient as never);
    const summary = await service.queryCosts('sub', '2026-01-01', '2026-01-31', 'service');
    expect(summary.totalAmount).toBe(150);
    expect(summary.byService).toEqual({ Compute: 100, Storage: 50 });
  });

  it('caches query results', async () => {
    usageMock.mockResolvedValue({
      columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }],
      rows: [[10, '2026-01-01']],
    });
    const service = new CostAnalyzerService(azureClient as never);
    await service.queryCosts('sub', '2026-01-01', '2026-01-31', 'service');
    await service.queryCosts('sub', '2026-01-01', '2026-01-31', 'service');
    expect(usageMock).toHaveBeenCalledTimes(1);
  });

  it('retrieves costs by period', async () => {
    usageMock.mockResolvedValue({
      columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }, { name: 'Currency' }, { name: 'ServiceName' }, { name: 'ResourceGroup' }, { name: 'ResourceLocation' }],
      rows: [[75, '2026-01-01', 'USD', 'Compute', 'rg-a', 'eastus']],
    });
    const service = new CostAnalyzerService(azureClient as never);
    const entries = await service.getCostsByPeriod(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.service).toBe('Compute');
  });

  it('analyzes month over month trends', async () => {
    usageMock.mockResolvedValue({
      columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }, { name: 'Currency' }, { name: 'ServiceName' }, { name: 'ResourceGroup' }, { name: 'ResourceLocation' }],
      rows: [
        [100, '2026-01-01', 'USD', 'Compute', 'rg-a', 'eastus'],
        [200, '2026-02-01', 'USD', 'Compute', 'rg-a', 'eastus'],
      ],
    });
    const service = new CostAnalyzerService(azureClient as never);
    const trends = await service.analyzeTrends(2);
    expect(trends).toHaveLength(2);
    expect(trends[1]?.percentChange).toBe(100);
  });

  it('detects anomalies above z-score threshold', () => {
    const service = new CostAnalyzerService(azureClient as never);
    const anomalies = service.detectAnomalies([
      { ...mockCostEntries[0], amount: 100 },
      { ...mockCostEntries[1], amount: 110 },
      { ...mockCostEntries[2], amount: 95 },
      { ...mockCostEntries[3], amount: 105 },
      { ...mockCostEntries[0], date: '2026-01-03', amount: 98 },
      { ...mockCostEntries[1], date: '2026-01-04', amount: 102 },
      { ...mockCostEntries[2], date: '2026-01-05', amount: 97 },
      { ...mockCostEntries[3], date: '2026-01-06', amount: 103 },
      { ...mockCostEntries[0], date: '2026-01-07', amount: 101 },
      { ...mockCostEntries[4], amount: 300 },
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]?.severity).toBe('medium');
  });

  it('returns no anomalies for flat datasets', () => {
    const service = new CostAnalyzerService(azureClient as never);
    const anomalies = service.detectAnomalies([
      { ...mockCostEntries[0], amount: 100 },
      { ...mockCostEntries[1], amount: 100 },
    ]);
    expect(anomalies).toEqual([]);
  });

  it('forecasts future costs', async () => {
    usageMock.mockResolvedValue({
      columns: [{ name: 'PreTaxCost' }, { name: 'UsageDate' }, { name: 'Currency' }, { name: 'ServiceName' }, { name: 'ResourceGroup' }, { name: 'ResourceLocation' }],
      rows: [
        [100, '2026-01-01', 'USD', 'Compute', 'rg-a', 'eastus'],
        [120, '2026-02-01', 'USD', 'Compute', 'rg-a', 'eastus'],
        [144, '2026-03-01', 'USD', 'Compute', 'rg-a', 'eastus'],
      ],
    });
    const service = new CostAnalyzerService(azureClient as never);
    const forecasts = await service.forecastCosts(3);
    expect(forecasts).toHaveLength(3);
    expect(forecasts[0]?.trend).toBe('up');
  });

  it('returns empty forecast when there are no trends', async () => {
    usageMock.mockResolvedValue({ columns: [], rows: [] });
    const service = new CostAnalyzerService(azureClient as never);
    await expect(service.forecastCosts(3)).resolves.toEqual([]);
  });

  it('wraps SDK failures with AzureApiError in queryCosts', async () => {
    usageMock.mockRejectedValue(new Error('boom'));
    const service = new CostAnalyzerService(azureClient as never);
    await expect(service.queryCosts('sub', '2026-01-01', '2026-01-31', 'service')).rejects.toBeInstanceOf(AzureApiError);
  });

  it('wraps SDK failures with AzureApiError in getCostsByPeriod', async () => {
    usageMock.mockRejectedValue(new Error('boom'));
    const service = new CostAnalyzerService(azureClient as never);
    await expect(service.getCostsByPeriod(1)).rejects.toBeInstanceOf(AzureApiError);
  });

  it.each([
    ['service', 'ServiceName'],
    ['resource-group', 'ResourceGroup'],
    ['location', 'ResourceLocation'],
    ['tags', 'TagKey'],
  ])('maps group-by %s into Azure dimensions', async (groupBy, dimension) => {
    usageMock.mockResolvedValue({ columns: [], rows: [] });
    const service = new CostAnalyzerService(azureClient as never);
    await service.queryCosts('sub', '2026-01-01', '2026-01-31', groupBy as 'service');
    expect(usageMock.mock.calls[0]?.[1]).toMatchObject({
      dataset: { grouping: [{ type: 'Dimension', name: dimension }] },
    });
  });

  it('constructs the Azure client', () => {
    new CostAnalyzerService(azureClient as never);
    expect(CostManagementClient).toBeDefined();
  });
});
