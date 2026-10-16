import { BusinessOutcomeLedgerSchema } from '@/models';
import type { BusinessOutcomeLedger, FinOpsInitiativeInput } from '@/models';
import { InitiativeLedgerService } from '@/services/initiative-ledger';
import type { ResourceCostLedger } from '@/services/cost-analyzer';

const sourceId = '/subscriptions/sub-a/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-old';
const destinationId = '/subscriptions/sub-b/resourceGroups/rg-b/providers/Microsoft.Compute/virtualMachines/vm-new';

const initiative: FinOpsInitiativeInput = {
  id: 'resize-checkout',
  appliedMonth: '2026-07',
  description: 'Move checkout workload to right-sized capacity',
  recommendationId: 'rec-42',
  sourceResourceIds: [sourceId],
  destinationResourceIds: [destinationId],
  tagKey: 'app',
  tagValue: 'checkout',
  unit: 'orders',
};

const outcomes = (
  rows: { period: string; status?: 'measured' | 'awaiting_closed_month'; quantity: number }[],
): BusinessOutcomeLedger =>
  BusinessOutcomeLedgerSchema.parse({
    latestSettledMonth: '2026-09',
    observations: rows.map((row) => ({
      period: row.period,
      tagKey: 'app',
      tagValue: 'checkout',
      unit: 'orders',
      quantity: row.quantity,
      status: row.status ?? 'measured',
      ...(row.status === 'awaiting_closed_month' ? {} : {
        currency: 'USD',
        observedCost: 1000,
        costPerUnit: 10,
      }),
      interpretation: 'test observation',
    })),
    limitations: ['test limitation'],
  });

const ledger = (resources: ResourceCostLedger['resources']): ResourceCostLedger => ({
  currency: 'USD',
  months: ['2026-06', '2026-08', '2026-09'],
  coveredMonths: ['2026-06', '2026-08', '2026-09'],
  resources,
});

describe('InitiativeLedgerService', () => {
  const service = new InitiativeLedgerService();

  it('parses a manifest and rejects invalid, duplicate or unscoped initiatives', () => {
    expect(service.parseJson(JSON.stringify({ initiatives: [initiative] }))).toEqual([initiative]);
    expect(() => service.parseJson('{')).toThrow('Initiatives JSON is invalid');
    expect(() => service.parseJson('{"initiatives":[]}')).toThrow('non-empty "initiatives" array');
    expect(() => service.parseJson(JSON.stringify({ initiatives: [initiative, initiative] }))).toThrow('Duplicate initiative id');
    expect(() => service.parseJson(JSON.stringify({
      initiatives: [{ ...initiative, sourceResourceIds: ['/resourceGroups/rg/resource'] }],
    }))).toThrow('without a subscription scope');
    expect(() => service.parseJson(JSON.stringify({
      initiatives: [{ ...initiative, destinationResourceIds: [sourceId] }],
    }))).toThrow('unique across initiative source and destination');
  });

  it('tracks cost moving from source to destination and measures cost per outcome', () => {
    const result = service.build(
      [initiative],
      outcomes([
        { period: '2026-06', quantity: 100 },
        { period: '2026-08', quantity: 120 },
        { period: '2026-09', quantity: 150 },
      ]),
      new Map([
        ['sub-a', ledger({ [sourceId.toLowerCase()]: { '2026-06': 1000, '2026-08': 200, '2026-09': 0 } })],
        ['sub-b', ledger({ [destinationId.toLowerCase()]: { '2026-06': 0, '2026-08': 400, '2026-09': 600 } })],
      ]),
      '2026-10-16T12:00:00.000Z',
    );

    expect(result.items[0]).toMatchObject({
      initiative: { id: 'resize-checkout' },
      status: 'improved',
      baselineMonth: '2026-06',
      observedMonth: '2026-09',
      baselineSourceSpend: 1000,
      observedSourceSpend: 0,
      baselineDestinationSpend: 0,
      observedDestinationSpend: 600,
      baselineTotalSpend: 1000,
      observedTotalSpend: 600,
      baselineVolume: 100,
      observedVolume: 150,
      baselineCostPerUnit: 10,
      observedCostPerUnit: 4,
      sourceSpendReduction: 1000,
      destinationSpendChange: 600,
      netSpendReduction: 400,
    });
    expect(result.items[0]?.explanation).toContain('não atribuída causalmente');
  });

  it('does not call a higher bill an efficiency regression when unit cost improved', () => {
    const result = service.build(
      [{ ...initiative, destinationResourceIds: [] }],
      outcomes([
        { period: '2026-06', quantity: 100 },
        { period: '2026-09', quantity: 200 },
      ]),
      new Map([['sub-a', ledger({
        [sourceId.toLowerCase()]: { '2026-06': 1000, '2026-09': 1500 },
      })]]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(result.items[0]).toMatchObject({
      status: 'improved',
      baselineTotalSpend: 1000,
      observedTotalSpend: 1500,
      baselineCostPerUnit: 10,
      observedCostPerUnit: 7.5,
      netSpendReduction: -500,
    });
  });

  it('reports awaiting post-period when no closed month follows the change', () => {
    const result = service.build(
      [initiative],
      outcomes([{ period: '2026-06', quantity: 100 }]),
      new Map([
        ['sub-a', ledger({ [sourceId.toLowerCase()]: { '2026-06': 100 } })],
        ['sub-b', ledger({ [destinationId.toLowerCase()]: {} })],
      ]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(result.items[0]).toMatchObject({
      status: 'awaiting_post_period',
      baselineMonth: '2026-06',
      baselineTotalSpend: 100,
      baselineCostPerUnit: 1,
    });
  });

  it('keeps missing billing coverage, currency differences and negative adjustments inconclusive', () => {
    const business = outcomes([
      { period: '2026-06', quantity: 100 },
      { period: '2026-09', quantity: 120 },
    ]);
    const withoutCoverage = service.build([initiative], business, new Map(), '2026-10-16T12:00:00.000Z');
    expect(withoutCoverage.items[0]?.status).toBe('billing_unavailable');

    const mixedCurrencies = service.build([initiative], business, new Map([
      ['sub-a', ledger({ [sourceId.toLowerCase()]: { '2026-06': 100, '2026-09': 50 } })],
      ['sub-b', { ...ledger({ [destinationId.toLowerCase()]: { '2026-06': 0, '2026-09': 10 } }), currency: 'EUR' }],
    ]), '2026-10-16T12:00:00.000Z');
    expect(mixedCurrencies.items[0]?.status).toBe('currency_mismatch');

    const creditLedger = ledger({
      [sourceId.toLowerCase()]: { '2026-06': 100, '2026-09': -5 },
    });
    const adjusted = service.build(
      [{ ...initiative, destinationResourceIds: [] }],
      business,
      new Map([['sub-a', creditLedger]]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(adjusted.items[0]?.status).toBe('billing_adjustment');
  });

  it('marks unavailable business volume and absent baseline spend explicitly', () => {
    const noVolume = service.build(
      [initiative],
      outcomes([
        { period: '2026-06', quantity: 100 },
        { period: '2026-09', quantity: 0 },
      ]),
      new Map([
        ['sub-a', ledger({ [sourceId.toLowerCase()]: { '2026-06': 100, '2026-09': 80 } })],
        ['sub-b', ledger({ [destinationId.toLowerCase()]: {} })],
      ]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(noVolume.items[0]?.status).toBe('business_metrics_unavailable');

    const noBaselineSpend = service.build(
      [initiative],
      outcomes([
        { period: '2026-06', quantity: 100 },
        { period: '2026-09', quantity: 100 },
      ]),
      new Map([
        ['sub-a', ledger({ [sourceId.toLowerCase()]: { '2026-06': 0, '2026-09': 0 } })],
        ['sub-b', ledger({ [destinationId.toLowerCase()]: {} })],
      ]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(noBaselineSpend.items[0]?.status).toBe('no_baseline_spend');
  });
});
