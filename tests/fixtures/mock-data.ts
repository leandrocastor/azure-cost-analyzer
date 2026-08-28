import type {
  CostEntry,
  CostSummary,
  IdleResource,
  Recommendation,
  Resource,
  ResourceMetric,
} from '@/models';

export const validEnv = {
  DATA_MODE: 'azure',
  AZURE_SUBSCRIPTION_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_TENANT_ID: '22222222-2222-2222-2222-222222222222',
  AZURE_CLIENT_ID: '33333333-3333-3333-3333-333333333333',
  AZURE_CLIENT_SECRET: 'super-secret-value',
  AUTH_METHOD: 'service-principal',
  CACHE_TTL_MINUTES: '15',
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'auto',
  DASHBOARD_PORT: '3000',
  NODE_ENV: 'test',
} satisfies NodeJS.ProcessEnv;

export const mockCostEntries: CostEntry[] = [
  { date: '2026-01-01', amount: 100, currency: 'USD', service: 'Compute', resourceGroup: 'rg-a', location: 'eastus', tags: {} },
  { date: '2026-01-02', amount: 105, currency: 'USD', service: 'Compute', resourceGroup: 'rg-a', location: 'eastus', tags: {} },
  { date: '2026-02-01', amount: 130, currency: 'USD', service: 'Storage', resourceGroup: 'rg-b', location: 'westus', tags: {} },
  { date: '2026-03-01', amount: 170, currency: 'USD', service: 'Database', resourceGroup: 'rg-c', location: 'centralus', tags: {} },
  { date: '2026-03-02', amount: 600, currency: 'USD', service: 'Database', resourceGroup: 'rg-c', location: 'centralus', tags: {} },
];

export const mockCostSummary: CostSummary = {
  period: '2026-01-01..2026-03-31',
  totalAmount: 1105,
  currency: 'USD',
  byService: { Compute: 205, Storage: 130, Database: 770 },
  byResourceGroup: { 'rg-a': 205, 'rg-b': 130, 'rg-c': 770 },
  byLocation: { eastus: 205, westus: 130, centralus: 770 },
};

export const mockMetrics: ResourceMetric[] = [
  { resourceId: 'vm-1', metricName: 'Percentage CPU', value: 1.5, unit: 'Percent', timestamp: '2026-03-01T00:00:00.000Z' },
  { resourceId: 'vm-1', metricName: 'Percentage CPU', value: 2.5, unit: 'Percent', timestamp: '2026-03-02T00:00:00.000Z' },
];

export const mockResource: Resource = {
  id: '/subscriptions/test/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a',
  name: 'vm-a',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg-a',
  location: 'eastus',
  sku: 'Standard_D2s_v5',
  tags: { environment: 'dev' },
  status: 'Succeeded',
};

export const mockIdleResources: IdleResource[] = [
  {
    resource: mockResource,
    reason: 'CPU below 5% for 7 days',
    idleScore: 90,
    estimatedMonthlySavings: 150,
    metrics: mockMetrics,
  },
  {
    resource: {
      id: '/subscriptions/test/resourceGroups/rg-b/providers/Microsoft.Storage/storageAccounts/storea',
      name: 'storea',
      type: 'Microsoft.Storage/storageAccounts',
      resourceGroup: 'rg-b',
      location: 'westus',
      sku: 'Premium_LRS',
      tags: {},
      status: 'Succeeded',
    },
    reason: 'No storage transactions for 30 days',
    idleScore: 85,
    estimatedMonthlySavings: 40,
    metrics: [],
  },
];

export const mockRecommendations: Recommendation[] = [
  {
    id: 'rec-1',
    type: 'Microsoft.Compute/virtualMachines',
    resourceId: mockResource.id,
    title: 'Optimize vm-a',
    description: 'CPU below 5% for 7 days.',
    monthlySavings: 180,
    annualSavings: 2160,
    risk: 'low',
    effort: 'medium',
    roi: 14.4,
    actionType: 'DOWNSIZE',
    status: 'new',
  },
];
