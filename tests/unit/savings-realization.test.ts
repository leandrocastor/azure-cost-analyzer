import type { IdleResource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import type { ReportSnapshot } from '@/services/cost-diff';
import { SavingsRealizationService } from '@/services/savings-realization';
import { mockCostSummary, mockIdleResources } from '../fixtures/mock-data';

const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-a';

const previousFinding = (overrides: Partial<IdleResource> = {}): IdleResource => ({
  ...mockIdleResources[0]!,
  resource: { ...mockIdleResources[0]!.resource, id: resourceId, name: 'disk-a' },
  reason: 'Disco sem anexação',
  evidence: {
    observationWindowDays: 30,
    dataPoints: 30,
    metrics: [],
    savingsBasis: 'observed-cost',
    savingsBasisDetail: 'Custo faturado.',
    confidence: 'high',
    billed: {
      observedTotal: 100,
      currency: 'BRL',
      monthly: { '2026-05': 100 },
      lastMonthWithCost: '2026-05',
      latestMonth: '2026-06',
      billingStopped: false,
      coveredMonths: ['2026-05', '2026-06'],
    },
  },
  ...overrides,
});

const previousSnapshot = (finding = previousFinding()): ReportSnapshot => ({
  generatedAt: '2026-06-15T12:00:00.000Z',
  subscriptionId: 'sub',
  costs: mockCostSummary,
  idleResources: [finding],
});

const ledger = (
  monthly: Record<string, number>,
  months = ['2026-06', '2026-07', '2026-08'],
  currency = 'BRL',
): ResourceCostLedger => ({
  currency,
  months: Object.keys(monthly),
  coveredMonths: months,
  resources: { [resourceId.toLowerCase()]: monthly },
});

describe('SavingsRealizationService', () => {
  const service = new SavingsRealizationService();
  const currentGeneratedAt = '2026-08-15T12:00:00.000Z';

  it('confirms a per-resource invoice reduction between settled months', () => {
    const result = service.analyze(
      previousSnapshot(),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({ '2026-07': 20 })]]),
    );

    expect(result.verifiedMonthlyReductionByCurrency).toEqual({ BRL: 80 });
    expect(result.verifiedCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      status: 'verified_reduction',
      baselineMonth: '2026-05',
      currentMonth: '2026-07',
      baselineCost: 100,
      currentCost: 20,
      monthlyReduction: 80,
    });
    expect(result.summary).toContain('não prova');
  });

  it('treats a missing current resource charge as zero only when the month is covered', () => {
    const result = service.analyze(
      previousSnapshot(),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({})]]),
    );

    expect(result.items[0]).toMatchObject({
      status: 'verified_reduction',
      currentCost: 0,
      monthlyReduction: 100,
    });
  });

  it('keeps verified reductions in separate currencies instead of summing them', () => {
    const secondId = '/subscriptions/sub-2/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-b';
    const secondFinding = previousFinding({
      resource: { ...previousFinding().resource, id: secondId, name: 'disk-b' },
      evidence: {
        ...previousFinding().evidence!,
        billed: {
          ...previousFinding().evidence!.billed!,
          observedTotal: 50,
          currency: 'USD',
          monthly: { '2026-05': 50 },
        },
      },
    });
    const result = service.analyze(
      { ...previousSnapshot(), idleResources: [previousFinding(), secondFinding] },
      [],
      currentGeneratedAt,
      new Map([
        ['sub', ledger({ '2026-07': 20 })],
        [
          'sub-2',
          {
            currency: 'USD',
            months: ['2026-07'],
            coveredMonths: ['2026-06', '2026-07', '2026-08'],
            resources: { [secondId.toLowerCase()]: { '2026-07': 40 } },
          },
        ],
      ]),
    );

    expect(result.verifiedMonthlyReductionByCurrency).toEqual({ BRL: 80, USD: 10 });
  });

  it('does not claim a reduction when the resource cost stayed the same or increased', () => {
    const result = service.analyze(
      previousSnapshot(),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({ '2026-07': 110 })]]),
    );

    expect(result.items[0]?.status).toBe('no_reduction');
    expect(result.verifiedMonthlyReductionByCurrency).toEqual({});
  });

  it('waits for a later settled month and does not compare month-to-date amounts', () => {
    const result = service.analyze(
      previousSnapshot(),
      [],
      '2026-06-20T12:00:00.000Z',
      new Map([['sub', ledger({ '2026-05': 50 }, ['2026-05', '2026-06'])]]),
    );

    expect(result.items[0]?.status).toBe('awaiting_period');
  });

  it('does not infer a zero baseline when the previous report lacks invoice coverage', () => {
    const finding = previousFinding();
    delete finding.evidence?.billed?.coveredMonths;
    const result = service.analyze(
      previousSnapshot(finding),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({ '2026-07': 0 })]]),
    );

    expect(result.items[0]?.status).toBe('baseline_unavailable');
  });

  it('does not compare costs across currencies or claim savings from negative adjustments', () => {
    const mismatch = service.analyze(
      previousSnapshot(),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({ '2026-07': 10 }, undefined, 'USD')]]),
    );
    const credit = service.analyze(
      previousSnapshot(),
      [],
      currentGeneratedAt,
      new Map([['sub', ledger({ '2026-07': -10 })]]),
    );

    expect(mismatch.items[0]?.status).toBe('currency_mismatch');
    expect(credit.items[0]?.status).toBe('no_reduction');
    expect(credit.verifiedMonthlyReductionByCurrency).toEqual({});
  });

  it('reports prior findings that could not be checked against current billing', () => {
    const result = service.analyze(previousSnapshot(), [], currentGeneratedAt, new Map());

    expect(result.items[0]?.status).toBe('current_cost_unavailable');
    expect(result.unmeasuredCount).toBe(1);
  });
});
