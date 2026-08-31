import type { Resource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { EnvironmentDetectorService, FORGOTTEN_ENV_THRESHOLD_DAYS } from '@/services/environment-detector';

const NOW = new Date('2026-08-31T00:00:00.000Z');

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  id: '/subscriptions/sub/resourceGroups/rg-dev/providers/Microsoft.Compute/virtualMachines/vm-test-01',
  name: 'vm-test-01',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg-dev',
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

describe('EnvironmentDetectorService', () => {
  it('flags an aged, billed resource whose name matches a non-prod pattern', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(120)]]);
    const ledger = buildLedger(resource.id, 180);

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(1);
    expect(report.resources[0]?.matchedOn).toBe('name');
    expect(report.resources[0]?.matchedPattern).toBe('test');
    expect(report.totalMonthlyCostAtRisk).toBe(180);
  });

  it('flags a resource matched only via its environment tag, not its name', () => {
    const resource = buildResource({
      id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-generic-01',
      name: 'vm-generic-01',
      tags: { environment: 'Homolog' },
    });
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(120)]]);
    const ledger = buildLedger(resource.id, 90);

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(1);
    expect(report.resources[0]?.matchedOn).toBe('tag');
    expect(report.resources[0]?.matchedTagKey).toBe('environment');
  });

  it('does not flag a resource younger than the forgotten-environment threshold', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(FORGOTTEN_ENV_THRESHOLD_DAYS - 1)]]);
    const ledger = buildLedger(resource.id, 180);

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('does not flag a resource whose age cannot be confirmed', () => {
    const resource = buildResource();
    const ledger = buildLedger(resource.id, 180);

    const report = new EnvironmentDetectorService().detect([resource], new Map(), ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
    expect(report.resourcesWithConfirmedAge).toBe(0);
  });

  it('does not flag a resource with no real billed cost', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(120)]]);
    const ledger: ResourceCostLedger = { currency: 'BRL', months: ['2026-08'], resources: {} };

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('does not flag a production-named resource with no non-prod tag', () => {
    const resource = buildResource({
      id: '/subscriptions/sub/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-prod-01',
      name: 'vm-prod-01',
      resourceGroup: 'rg-prod',
    });
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(400)]]);
    const ledger = buildLedger(resource.id, 300);

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, [], NOW);

    expect(report.resources).toHaveLength(0);
  });

  it('marks isIdle correctly when the resource also appears in idle findings', () => {
    const resource = buildResource();
    const creationTimes = new Map([[resource.id.toLowerCase(), daysAgo(120)]]);
    const ledger = buildLedger(resource.id, 180);
    const idleResources = [{ resource, idleScore: 90, estimatedMonthlySavings: 180 } as never];

    const report = new EnvironmentDetectorService().detect([resource], creationTimes, ledger, idleResources, NOW);

    expect(report.resources[0]?.isIdle).toBe(true);
  });

  it('returns an empty summary when nothing is found', () => {
    const report = new EnvironmentDetectorService().detect([], new Map(), { currency: 'BRL', months: [], resources: {} }, [], NOW);

    expect(report.resources).toHaveLength(0);
    expect(report.summary).toContain('Nenhum ambiente');
  });
});
