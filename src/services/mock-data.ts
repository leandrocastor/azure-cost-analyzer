import type { CostEntry, IdleResource } from '@/models';

export const mockCostEntries: CostEntry[] = [
  {
    date: '2026-01-01',
    amount: 100,
    currency: 'USD',
    service: 'Compute',
    resourceGroup: 'rg-a',
    location: 'eastus',
    tags: {},
  },
  {
    date: '2026-01-02',
    amount: 105,
    currency: 'USD',
    service: 'Compute',
    resourceGroup: 'rg-a',
    location: 'eastus',
    tags: {},
  },
  {
    date: '2026-02-01',
    amount: 130,
    currency: 'USD',
    service: 'Storage',
    resourceGroup: 'rg-b',
    location: 'westus',
    tags: {},
  },
  {
    date: '2026-03-01',
    amount: 170,
    currency: 'USD',
    service: 'Database',
    resourceGroup: 'rg-c',
    location: 'centralus',
    tags: {},
  },
  {
    date: '2026-03-02',
    amount: 600,
    currency: 'USD',
    service: 'Database',
    resourceGroup: 'rg-c',
    location: 'centralus',
    tags: {},
  },
];

export const mockIdleResources: IdleResource[] = [
  {
    resource: {
      id: '/subscriptions/mock/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-a',
      name: 'vm-a',
      type: 'Microsoft.Compute/virtualMachines',
      resourceGroup: 'rg-a',
      location: 'eastus',
      sku: 'Standard_D2s_v5',
      tags: { environment: 'dev' },
      status: 'Succeeded',
    },
    reason: 'CPU below 5% for 7 days',
    idleScore: 90,
    estimatedMonthlySavings: 150,
    metrics: [],
  },
  {
    resource: {
      id: '/subscriptions/mock/resourceGroups/rg-b/providers/Microsoft.Storage/storageAccounts/storea',
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
