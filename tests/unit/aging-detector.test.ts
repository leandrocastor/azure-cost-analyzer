import type { IdleResource, Resource } from '@/models';
import { AGING_THRESHOLD_DAYS, AgingDetectorService } from '@/services/aging-detector';
import type { ResourceCostLedger } from '@/services/cost-analyzer';

const NOW = new Date('2026-08-31T00:00:00.000Z');

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-old',
  name: 'vm-old',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg-a',
  location: 'brazilsouth',
  sku: 'Standard_D2s_v3',
  tags: {},
  status: 'Succeeded',
  ...overrides,
});

const buildLedger = (resourceId: string, amount: number): ResourceCostLedger => ({
  currency: 'BRL',
  months: ['2026-06', '2026-07', '2026-08'],
  resources: { [resourceId.toLowerCase()]: { '2026-06': amount, '2026-07': amount, '2026-08': amount } },
});

describe('AgingDetectorService', () => {
  it('flags a resource that is old, billed, and has no owner tag', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(400)]]);
    const ledger = buildLedger(resource.id, 250);

    const report = new AgingDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(1);
    expect(report.resources[0]?.ageDays).toBe(400);
    expect(report.resources[0]?.monthlyCost).toBe(250);
    expect(report.totalMonthlyCostAtRisk).toBe(250);
  });

  it('does not flag a resource whose age cannot be confirmed by Resource Graph', () => {
    const resource = buildResource();
    const ledger = buildLedger(resource.id, 250);

    // No entry in creationTimes: the age is unknown, not "recent" or "old".
    const report = new AgingDetectorService().detect([resource], new Map(), ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
    expect(report.resourcesWithConfirmedAge).toBe(0);
  });

  it('does not flag a resource younger than the aging threshold', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(AGING_THRESHOLD_DAYS - 1)]]);
    const ledger = buildLedger(resource.id, 250);

    const report = new AgingDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('does not flag an old resource that is not generating billed cost', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(400)]]);
    const ledger: ResourceCostLedger = { currency: 'BRL', months: ['2026-08'], resources: {} };

    const report = new AgingDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('does not flag an old, billed resource that carries an owner tag', () => {
    const resource = buildResource({ tags: { owner: 'time-plataforma' } });
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(400)]]);
    const ledger = buildLedger(resource.id, 250);

    const report = new AgingDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('marks a finding as also idle when it appears in the idle resources list', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(400)]]);
    const ledger = buildLedger(resource.id, 250);
    const idleResources: IdleResource[] = [
      {
        resource,
        reason: 'CPU baixa',
        idleScore: 90,
        estimatedMonthlySavings: 100,
        metrics: [],
      },
    ];

    const report = new AgingDetectorService().detect([resource], creationTimes, ledger, idleResources, NOW);

    expect(report.resources[0]?.isIdle).toBe(true);
  });

  it('summarizes with zero findings when nothing matches', () => {
    const report = new AgingDetectorService().detect([], new Map(), { currency: 'BRL', months: [], resources: {} }, [], NOW);

    expect(report.resources).toHaveLength(0);
    expect(report.summary).toContain('Nenhum recurso');
  });
});
