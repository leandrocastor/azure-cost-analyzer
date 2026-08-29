import type { CostSummary, IdleResource, Resource } from '@/models';
import type { ReportSnapshot } from '@/services/cost-diff';
import { InactionCostService } from '@/services/inaction-cost';

const buildResource = (name: string): Resource => ({
  id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/disks/${name}`,
  name,
  type: 'Microsoft.Compute/disks',
  resourceGroup: 'rg',
  location: 'brazilsouth',
  sku: 'Premium_LRS',
  tags: {},
  status: 'Succeeded',
});

const buildIdle = (name: string, monthlySavings: number): IdleResource => ({
  resource: buildResource(name),
  reason: 'Disco não está anexado a nenhuma VM',
  idleScore: 95,
  estimatedMonthlySavings: monthlySavings,
  metrics: [],
});

const costs: CostSummary = {
  period: 'p',
  totalAmount: 1000,
  currency: 'BRL',
  byService: {},
  byResourceGroup: {},
  byLocation: {},
};

const buildSnapshot = (generatedAt: string, idleResources: IdleResource[]): ReportSnapshot => ({
  generatedAt,
  subscriptionId: 'sub',
  costs,
  idleResources,
});

const NOW = new Date('2026-08-29T00:00:00Z');
const NINETY_DAYS_AGO = '2026-05-31T00:00:00Z';

describe('InactionCostService', () => {
  const service = new InactionCostService();

  it('charges a stale finding from the day it was first reported', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 30)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.daysBetween).toBe(90);
    expect(result.stale).toHaveLength(1);
    // 30 per month over 90 days is three months of avoidable spend.
    expect(result.stale[0]?.wastedSoFar).toBe(90);
    expect(result.totalWasted).toBe(90);
  });

  it('ignores findings that appeared only in the current run', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, []);
    const result = service.analyze(previous, [buildIdle('disk-new', 30)], NOW);

    expect(result.stale).toHaveLength(0);
    expect(result.totalWasted).toBe(0);
  });

  it('counts findings that were resolved since the previous run', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 30), buildIdle('disk-b', 10)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.resolved).toBe(1);
    expect(result.stale).toHaveLength(1);
  });

  it('projects the annual waste of everything still open', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 30), buildIdle('disk-b', 20)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30), buildIdle('disk-b', 20)], NOW);

    expect(result.projectedAnnualWaste).toBe(600);
  });

  it('orders findings by how much they have already cost', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('cheap', 5), buildIdle('expensive', 500)]);
    const result = service.analyze(previous, [buildIdle('cheap', 5), buildIdle('expensive', 500)], NOW);

    expect(result.stale[0]?.resourceName).toBe('expensive');
  });

  it('uses the current savings figure so the number reflects todays prices', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 10)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.stale[0]?.monthlySavings).toBe(30);
  });

  it('congratulates a tenant that closed everything', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 30)]);
    const result = service.analyze(previous, [], NOW);

    expect(result.stale).toHaveLength(0);
    expect(result.resolved).toBe(1);
    expect(result.summary).toContain('resolvidas');
  });

  it('summarizes the accumulated debt in plain language', () => {
    const previous = buildSnapshot(NINETY_DAYS_AGO, [buildIdle('disk-a', 30)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.summary).toContain('90 dias');
    expect(result.summary).toContain('90.00');
  });

  it('never reports negative time when the baseline is newer than the run', () => {
    const previous = buildSnapshot('2026-12-01T00:00:00Z', [buildIdle('disk-a', 30)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.daysBetween).toBe(0);
    expect(result.totalWasted).toBe(0);
  });

  it('tolerates a baseline with an unreadable timestamp', () => {
    const previous = buildSnapshot('not-a-date', [buildIdle('disk-a', 30)]);
    const result = service.analyze(previous, [buildIdle('disk-a', 30)], NOW);

    expect(result.daysBetween).toBe(0);
  });
});
