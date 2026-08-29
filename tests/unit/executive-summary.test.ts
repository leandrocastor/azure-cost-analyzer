import { describe, expect, it } from 'vitest';

import type { CostDiff } from '@/models';
import { ExecutiveSummaryService, type ExecutiveSummaryInput } from '@/services/executive-summary';
import { OptimizerService } from '@/services/optimizer';
import { OwnershipService } from '@/services/ownership';
import { mockCostSummary, mockIdleResources } from '../fixtures/mock-data';

const ownership = new OwnershipService().buildReport(mockIdleResources);

const buildInput = async (
  overrides: Partial<ExecutiveSummaryInput> = {},
): Promise<ExecutiveSummaryInput> => ({
  costs: mockCostSummary,
  idleResources: mockIdleResources,
  recommendations: await new OptimizerService().generateRecommendations(mockIdleResources),
  ownership,
  subscriptionCount: 2,
  ...overrides,
});

const diff: CostDiff = {
  previousGeneratedAt: '2026-01-01T00:00:00.000Z',
  previousPeriod: 'jan',
  currentPeriod: 'fev',
  totalPrevious: 1000,
  totalCurrent: 1105,
  totalDelta: 105,
  totalPercentChange: 10.5,
  currency: 'USD',
  byService: [{ key: 'Database', previous: 700, current: 770, delta: 70, percentChange: 10 }],
  byResourceGroup: [],
  idleCountPrevious: 3,
  idleCountCurrent: 2,
  newIdleResources: [],
  resolvedIdleResources: ['vm-antiga'],
};

describe('ExecutiveSummaryService', () => {
  const service = new ExecutiveSummaryService();

  it('writes a headline with the recoverable annual savings', async () => {
    const summary = service.build(await buildInput());

    expect(summary.headline).toMatch(/desperdício recuperável/i);
    expect(summary.generatedBy).toBe('heuristic');
    expect(summary.paragraphs.length).toBeGreaterThan(0);
  });

  it('states that nothing was found when there is no idle resource', async () => {
    const summary = service.build(
      await buildInput({
        idleResources: [],
        recommendations: [],
        ownership: new OwnershipService().buildReport([]),
      }),
    );

    expect(summary.headline).toMatch(/nenhum desperdício relevante/i);
  });

  it('names the service that concentrates the highest spend', async () => {
    const summary = service.build(await buildInput());

    expect(summary.paragraphs.join(' ')).toContain('Database');
  });

  it('attributes the largest waste to the top owner', async () => {
    const summary = service.build(await buildInput());

    expect(summary.paragraphs.join(' ')).toContain(ownership.owners[0]!.owner);
  });

  it('describes the variation against the previous report when a diff is provided', async () => {
    const summary = service.build(await buildInput({ diff }));

    expect(summary.paragraphs.join(' ')).toMatch(/aumento/i);
    expect(summary.paragraphs.join(' ')).toContain('Database');
    expect(summary.highlights.some((item) => item.label.includes('Variação'))).toBe(true);
  });

  it('flags a growing bill as a negative highlight', async () => {
    const summary = service.build(await buildInput({ diff }));
    const variation = summary.highlights.find((item) => item.label.includes('Variação'));

    expect(variation?.tone).toBe('negative');
  });

  it('reports the analyzed scope in the highlights', async () => {
    const summary = service.build(await buildInput({ subscriptionCount: 4 }));

    expect(summary.highlights.some((item) => item.value === '4 subscriptions')).toBe(true);
  });

  it('lists at most three prioritized actions ordered by annual savings', async () => {
    const summary = service.build(await buildInput());

    expect(summary.topActions.length).toBeLessThanOrEqual(3);
    expect(summary.topActions[0]).toMatch(/^1\. /);
  });

  it('does not divide by zero when the total cost is zero', async () => {
    const summary = service.build(
      await buildInput({ costs: { ...mockCostSummary, totalAmount: 0 } }),
    );

    expect(summary.highlights.some((item) => item.value === 'NaN%')).toBe(false);
  });
});
