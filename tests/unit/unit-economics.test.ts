import type { Resource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { UnitEconomicsService } from '@/services/unit-economics';

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-1',
  name: 'vm-1',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg-a',
  location: 'brazilsouth',
  sku: 'Standard_D2s_v3',
  tags: {},
  status: 'Succeeded',
  ...overrides,
});

const buildLedger = (entries: [string, number][]): ResourceCostLedger => ({
  currency: 'BRL',
  months: ['2026-08'],
  resources: Object.fromEntries(entries.map(([id, amount]) => [id.toLowerCase(), { '2026-08': amount }])),
});

describe('UnitEconomicsService', () => {
  it('groups real billed cost by the first tag key actually used in the estate', () => {
    const resources = [
      buildResource({ id: 'r1', name: 'vm-1', tags: { app: 'checkout' } }),
      buildResource({ id: 'r2', name: 'vm-2', tags: { app: 'checkout' } }),
      buildResource({ id: 'r3', name: 'vm-3', tags: { app: 'billing' } }),
    ];
    const ledger = buildLedger([
      ['r1', 100],
      ['r2', 50],
      ['r3', 30],
    ]);

    const report = new UnitEconomicsService().build(resources, ledger);

    expect(report?.groupTagKey).toBe('app');
    expect(report?.entries[0]?.key).toBe('checkout');
    expect(report?.entries[0]?.monthlyCost).toBe(150);
    expect(report?.entries[1]?.key).toBe('billing');
  });

  it('accumulates cost from resources without the tag as untagged, not invented', () => {
    const resources = [
      buildResource({ id: 'r1', name: 'vm-1', tags: { app: 'checkout' } }),
      buildResource({ id: 'r2', name: 'vm-2', tags: {} }),
    ];
    const ledger = buildLedger([
      ['r1', 100],
      ['r2', 40],
    ]);

    const report = new UnitEconomicsService().build(resources, ledger);

    expect(report?.untaggedMonthlyCost).toBe(40);
    expect(report?.untaggedResourceCount).toBe(1);
    expect(report?.taggedMonthlyCost).toBe(100);
  });

  it('returns undefined when none of the candidate tags are used anywhere', () => {
    const resources = [buildResource({ tags: { owner: 'time-a' } })];
    const ledger = buildLedger([['r1', 100]]);

    const report = new UnitEconomicsService().build(resources, ledger);

    expect(report).toBeUndefined();
  });
});
