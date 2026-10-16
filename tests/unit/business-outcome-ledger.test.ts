import { BusinessOutcomeLedgerService } from '@/services/business-outcome-ledger';
import type { TaggedCostEntry } from '@/services/cost-analyzer';

const csv = [
  'period,tag_key,tag_value,unit,quantity',
  '2026-08,app,checkout,orders,100',
  '2026-09,app,checkout,orders,120',
  '2026-10,app,checkout,orders,130',
].join('\n');

const taggedCosts = (entries: TaggedCostEntry[]): Map<string, Map<string, TaggedCostEntry[]>> =>
  new Map([['subscription-a', new Map([['app', entries]])]]);

describe('BusinessOutcomeLedgerService', () => {
  const service = new BusinessOutcomeLedgerService();

  it('requires two consecutive closed months inside the query window, including the billing buffer', () => {
    expect(() => service.assertComparisonWindow('2026-09', '2026-10-16T12:00:00.000Z')).toThrow(
      'at least two conservatively closed consecutive months',
    );
    expect(() => service.assertComparisonWindow('2026-08', '2026-10-16T12:00:00.000Z')).not.toThrow();
    expect(() => service.assertComparisonWindow('2026-08', '2026-10-06T12:00:00.000Z')).toThrow(
      'at least two conservatively closed consecutive months',
    );
    expect(() => service.assertComparisonWindow('2026-07', '2026-10-06T12:00:00.000Z')).not.toThrow();
  });

  it('parses quoted values, BOMs, case-insensitive headers, and reordered columns', () => {
    const metrics = service.parseCsv(
      '\uFEFFQUANTITY,UNIT,TAG_VALUE,PERIOD,TAG_KEY\r\n10,"API calls","checkout, blue",2026-09,App\r\n',
    );
    expect(metrics).toEqual([{
      period: '2026-09',
      tagKey: 'App',
      tagValue: 'checkout, blue',
      unit: 'API calls',
      quantity: 10,
    }]);
  });

  it.each([
    ['missing a required header', 'period,tag_key,tag_value,quantity\n2026-09,app,checkout,1'],
    ['contains no data rows', 'period,tag_key,tag_value,unit,quantity\n'],
    ['has a duplicate month/tag/unit', `${csv}\n2026-09,app,checkout,orders,121`],
    ['has a negative quantity', 'period,tag_key,tag_value,unit,quantity\n2026-09,app,checkout,orders,-1'],
    ['has an invalid month', 'period,tag_key,tag_value,unit,quantity\n2026-13,app,checkout,orders,1'],
    ['has an unterminated quoted field', 'period,tag_key,tag_value,unit,quantity\n2026-09,app,"checkout,orders,1'],
  ])('rejects CSV that %s', (_reason, input) => {
    expect(() => service.parseCsv(input)).toThrow();
  });

  it('compares billed cost with business volume and calculates the efficiency gap', () => {
    const metrics = service.parseCsv(csv);
    const ledger = service.build(metrics, taggedCosts([
      { period: '2026-08', tagValue: 'checkout', amount: 1000, currency: 'USD' },
      { period: '2026-09', tagValue: 'checkout', amount: 1500, currency: 'USD' },
    ]), '2026-10-16T12:00:00.000Z');

    expect(ledger.latestSettledMonth).toBe('2026-09');
    expect(ledger.observations[1]).toMatchObject({
      period: '2026-09',
      status: 'measured',
      observedCost: 1500,
      costPerUnit: 12.5,
      spendChangePercent: 50,
      volumeChangePercent: 20,
      costPerUnitChangePercent: 25,
      efficiencyGap: 300,
    });
    expect(ledger.observations[2]?.status).toBe('awaiting_closed_month');
    expect(ledger.observations[2]?.observedCost).toBeUndefined();
    expect(ledger.limitations.join(' ')).toContain('não previsão');
  });

  it('does not treat absent billed rows as zero cost or infer a tag match', () => {
    const ledger = service.build(
      service.parseCsv('period,tag_key,tag_value,unit,quantity\n2026-09,app,unknown,orders,10'),
      taggedCosts([]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(ledger.observations[0]).toMatchObject({
      status: 'no_billed_cost',
      interpretation: expect.stringContaining('confirme cobertura'),
    });
    expect(ledger.observations[0]?.costPerUnit).toBeUndefined();
  });

  it('keeps currencies separate instead of dividing partial spend by total volume', () => {
    const ledger = service.build(
      service.parseCsv('period,tag_key,tag_value,unit,quantity\n2026-09,app,checkout,orders,10'),
      new Map([
        ['subscription-a', new Map([['app', [{ period: '2026-09', tagValue: 'checkout', amount: 100, currency: 'USD' }]]])],
        ['subscription-b', new Map([['app', [{ period: '2026-09', tagValue: 'checkout', amount: 200, currency: 'BRL' }]]])],
      ]),
      '2026-10-16T12:00:00.000Z',
    );
    expect(ledger.observations[0]).toMatchObject({
      status: 'multiple_currencies',
      observedCostByCurrency: { USD: 100, BRL: 200 },
    });
    expect(ledger.observations[0]?.costPerUnit).toBeUndefined();
  });

  it('retains billed cost without creating a ratio for zero volume or negative net charges', () => {
    const metrics = service.parseCsv([
      'period,tag_key,tag_value,unit,quantity',
      '2026-09,app,idle,orders,0',
      '2026-09,app,credit,orders,10',
    ].join('\n'));
    const ledger = service.build(metrics, taggedCosts([
      { period: '2026-09', tagValue: 'idle', amount: 50, currency: 'USD' },
      { period: '2026-09', tagValue: 'credit', amount: -5, currency: 'USD' },
    ]), '2026-10-16T12:00:00.000Z');
    expect(ledger.observations.map((item) => item.status)).toEqual(['negative_net_cost', 'zero_business_volume']);
    expect(ledger.observations.every((item) => item.costPerUnit === undefined)).toBe(true);
  });

  it('only compares consecutive months in the same tag and unit series', () => {
    const metrics = service.parseCsv([
      'period,tag_key,tag_value,unit,quantity',
      '2026-07,app,checkout,orders,100',
      '2026-09,app,checkout,orders,120',
    ].join('\n'));
    const ledger = service.build(metrics, taggedCosts([
      { period: '2026-07', tagValue: 'checkout', amount: 1000, currency: 'USD' },
      { period: '2026-09', tagValue: 'checkout', amount: 1500, currency: 'USD' },
    ]), '2026-10-16T12:00:00.000Z');
    expect(ledger.observations[1]?.costPerUnitChangePercent).toBeUndefined();
    expect(ledger.observations[1]?.efficiencyGap).toBeUndefined();
  });
});
