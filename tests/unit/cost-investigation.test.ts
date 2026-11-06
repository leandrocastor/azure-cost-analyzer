import { createHash } from 'node:crypto';

import { generateInvestigationReport } from '@/dashboard/investigation-report';
import { INVESTIGATION_DEMO } from '../../src/demo/cost-investigation';
import { CostInvestigationService } from '@/services/cost-investigation';

const HEADER =
  'BillingPeriodStart,BillingPeriodEnd,BillingCurrency,BilledCost,ServiceName,ChargeCategory,ResourceId';
const baseline = '2026-08';
const current = '2026-09';
const row = (
  month: string,
  cost: string,
  currency = 'BRL',
  resource = '/subscriptions/demo/vm',
): string =>
  `${month}-01,${month === baseline ? current : '2026-10'}-01,${currency},${cost},Compute,Usage,${resource}`;
const service = new CostInvestigationService();
const analyze = (csv: string): ReturnType<CostInvestigationService['analyze']> =>
  service.analyze([{ name: 'focus.csv', content: csv }], baseline, current);
const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n');

describe('offline FOCUS investigation', () => {
  it('separates credit and purchase movements from usage, then decomposes comparable usage', () => {
    const result = analyze(INVESTIGATION_DEMO.csv);
    const brl = result.currencies[0]!;
    expect(brl.billingBridge.map((item) => [item.chargeCategory, item.delta])).toEqual([
      ['Usage', '430.00'],
      ['Credit', '100.00'],
      ['Purchase', '300.00'],
    ]);
    expect(
      brl.usageExplanations.find((item) => item.dimensions.skuId === 'demo-sku'),
    ).toMatchObject({
      status: 'decomposed',
      baselineQuantity: '100.00',
      currentQuantity: '120.00',
      quantityEffect: '200.00',
      observedUnitCostEffect: '250.00',
      delta: '450.00',
    });
    expect(
      brl.usageExplanations.find((item) => item.dimensions.serviceName === 'Storage'),
    ).toMatchObject({ status: 'insufficient-evidence' });
  });

  const usageCsv = (
    quantity0: string,
    quantity1: string,
    cost0 = '100',
    cost1 = '180',
    changes: { unit?: string; meter?: string; correction?: string } = {},
  ): string => {
    const header = `${HEADER},ProviderName,BillingAccountId,SubAccountId,SkuId,x_SkuMeterId,PricingCategory,PricingQuantity,PricingUnit,ChargeClass`;
    return (
      `${header}\n` +
      `${row(baseline, cost0)},Microsoft,account,sub,sku,meter,Standard,${quantity0},Hours,${changes.correction ?? ''}\n` +
      `${row(current, cost1)},Microsoft,account,sub,sku,${changes.meter ?? 'meter'},Standard,${quantity1},${changes.unit ?? 'Hours'},${changes.correction ?? ''}`
    );
  };

  it.each([
    ['10', '15', '100', '150', '50.00', '0.00'],
    ['10', '10', '100', '130', '0.00', '30.00'],
    ['10', '5', '100', '40', '-50.00', '-10.00'],
    ['3', '4', '1', '2', '0.333333333333333333', '0.666666666666666667'],
    ['10', '20', '0', '50', '0.00', '50.00'],
  ])(
    'reconciles the quantity bridge exactly (%s → %s)',
    (q0, q1, c0, c1, quantityEffect, rateEffect) => {
      const result = analyze(usageCsv(q0, q1, c0, c1)).currencies[0]!.usageExplanations[0]!;
      expect(result).toMatchObject({
        status: 'decomposed',
        quantityEffect,
        observedUnitCostEffect: rateEffect,
      });
      expect(result.reason).toContain('Não comprova mudança de tarifa');
    },
  );

  it.each([
    ['', '20', '100', '200'],
    ['not-numeric', '20', '100', '200'],
    ['0', '20', '0', '200'],
    ['-1', '20', '100', '200'],
    ['10', '20', '-10', '200'],
  ])('retains the bill but does not decompose unsupported quantity data %j', (q0, q1, c0, c1) => {
    const result = analyze(usageCsv(q0, q1, c0, c1)).currencies[0]!;
    expect(result.usageExplanations[0]!.status).toBe('insufficient-evidence');
    expect(result.currentCost).toBe(`${c1}.00`);
    expect(result.usageExplanations[0]!.quantityEffect).toBeUndefined();
  });

  it.each([{ unit: 'GB' }, { meter: 'other-meter' }])(
    'does not blend incompatible units or meters %j',
    (changes) => {
      const items = analyze(usageCsv('10', '20', '100', '200', changes)).currencies[0]!
        .usageExplanations;
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.status === 'insufficient-evidence')).toBe(true);
    },
  );

  it('keeps corrections separate and refuses to treat them as normal quantity growth', () => {
    const result = analyze(usageCsv('10', '20', '100', '200', { correction: 'Correction' }))
      .currencies[0]!;
    expect(result.usageExplanations[0]!.reason).toContain('ChargeClass');
    expect(result.billingBridge[0]!.interpretation).toContain('Correção');
  });

  it('reconciles all demo movements by currency and links every driver to source rows', () => {
    const result = analyze(INVESTIGATION_DEMO.csv);
    const brl = result.currencies[0]!;
    expect(brl).toMatchObject({
      currency: 'BRL',
      baselineCost: '1050.00',
      currentCost: '1880.00',
      delta: '830.00',
      hasBothPeriods: true,
    });
    expect(result.currencies[1]).toMatchObject({ currency: 'USD', delta: '2.00' });
    expect(brl.breakdowns.chargeCategory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimensions: expect.objectContaining({ chargeCategory: 'Credit' }),
          delta: '100.00',
        }),
        expect.objectContaining({
          dimensions: expect.objectContaining({ chargeCategory: 'Purchase' }),
          delta: '300.00',
          presence: 'current-only',
        }),
      ]),
    );
    for (const breakdown of Object.values(brl.breakdowns)) {
      expect(
        breakdown
          .flatMap((driver) => [...driver.evidence.baseline, ...driver.evidence.current])
          .sort(),
      ).toEqual(
        result.evidence
          .filter((entry) => entry.currency === 'BRL')
          .map((entry) => entry.id)
          .sort(),
      );
      const integerDelta = breakdown.reduce((sum, driver) => sum + Number(driver.delta), 0);
      expect(integerDelta).toBe(830);
    }
    expect(result.warnings.join(' ')).toContain('sem ResourceId');
  });

  it('retains exact fractional costs, scientific notation and refunds without float rounding', () => {
    const result = analyze(
      csv(
        row(baseline, '0.1'),
        row(baseline, '0.2'),
        row(baseline, '-0.3'),
        row(current, '1e-18'),
        row(current, '9007199254740993'),
      ),
    );
    expect(result.currencies[0]).toMatchObject({
      baselineCost: '0.00',
      currentCost: '9007199254740993.000000000000000001',
      delta: '9007199254740993.000000000000000001',
    });
    expect(result.currencies[0]!.breakdowns.resource[0]!.delta).toBe(
      '9007199254740993.000000000000000001',
    );
  });

  it('sorts aggregate movements exactly even when their sum exceeds one row precision limit', () => {
    const result = analyze(
      csv(
        row(baseline, '-999999999999999999999999999999'),
        row(current, '999999999999999999999999999999'),
        row(current, '1', 'BRL', '/subscriptions/demo/other'),
      ),
    );
    expect(result.currencies[0]!.breakdowns.resource[0]!.delta).toBe(
      '1999999999999999999999999999998.00',
    );
    expect(result.currencies[0]!.delta).toBe('1999999999999999999999999999999.00');
  });

  it('parses BOM, CRLF, escaped quotes and multiline fields with physical line provenance', () => {
    const content = `\uFEFF${HEADER}\r\n${row(baseline, '1').replace('Compute', '"Compute, ""legacy""\r\nservice"')}\r\n${row(current, '2')}\r\n`;
    const result = analyze(content);
    expect(result.evidence[0]).toMatchObject({
      id: 'source-1-record-2',
      record: 2,
      startLine: 2,
      endLine: 3,
      serviceName: 'Compute, "legacy"\nservice',
    });
    expect(result.evidence[1]).toMatchObject({ startLine: 4, endLine: 4 });
    expect(result.sources[0]!.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(analyze(content)).toEqual(result);
  });

  it('merges case-insensitive ARM IDs but does not collapse resources from different accounts', () => {
    const content =
      `${HEADER},BillingAccountId\n` +
      `${row(baseline, '10', 'BRL', '/SUBSCRIPTIONS/demo/VM')},account-a\n` +
      `${row(current, '12')},account-a\n` +
      `${row(current, '5')},account-b`;
    const drivers = analyze(content).currencies[0]!.breakdowns.resource;
    expect(drivers).toHaveLength(2);
    expect(
      drivers.find((driver) => driver.dimensions.billingAccountId === 'account-a'),
    ).toMatchObject({ delta: '2.00', presence: 'both' });
  });

  it('does not present a missing currency period as a comparable zero-cost baseline', () => {
    const result = analyze(csv(row(baseline, '5', 'BRL'), row(current, '7', 'USD')));
    expect(result.currencies.every((item) => !item.hasBothPeriods)).toBe(true);
    expect(result.warnings.filter((warning) => warning.includes('apenas um período'))).toHaveLength(
      2,
    );
    expect(result.limitations.join(' ')).toContain('não comprova criação ou exclusão');
  });

  it('keeps identical records with a warning instead of silently deduplicating real charges', () => {
    const content = csv(row(baseline, '10'), row(current, '5'), row(current, '5'));
    const result = analyze(content);
    expect(result.currencies[0]!.currentCost).toBe('10.00');
    expect(result.warnings.join(' ')).toContain('1 linha(s) com conteúdo repetido');
    expect(() =>
      service.analyze(
        [
          { name: 'a.csv', content },
          { name: 'copy.csv', content },
        ],
        baseline,
        current,
      ),
    ).toThrow('Duplicate input file: copy.csv');
  });

  it('combines monthly partitions and excludes other months explicitly', () => {
    const result = service.analyze(
      [
        { name: 'aug.csv', content: csv(row(baseline, '10')) },
        { name: 'sep.csv', content: csv(row(current, '20'), row('2026-07', '3')) },
      ],
      baseline,
      current,
    );
    expect(result.currencies[0]!.delta).toBe('10.00');
    expect(result.sources[1]).toMatchObject({ rowCount: 2, selectedRowCount: 1 });
    expect(result.warnings.join(' ')).toContain('1 linha(s) fora');
    expect(result.evidence).toHaveLength(2);
  });

  it('rejects missing periods, reversed windows and non-FOCUS input', () => {
    expect(() => analyze(csv(row(baseline, '1')))).toThrow('No rows for billing period 2026-09');
    expect(() => service.analyze([], current, baseline)).toThrow('--baseline earlier');
    expect(() => service.analyze([], baseline, current)).toThrow('at least one');
    expect(() => analyze('Date,Cost\n2026-08-01,10')).toThrow('Missing FOCUS columns');
    expect(() => analyze(`${HEADER},BilledCost`)).toThrow('Duplicate CSV column');
    expect(() => analyze('')).toThrow('CSV is empty');
  });

  it.each(['NaN', 'Infinity', '', '1.0000000000000000001', '1e99', '1,20'])(
    'rejects invalid or unsupported monetary data rather than dropping the row: %s',
    (cost) => {
      expect(() => analyze(csv(row(baseline, cost), row(current, '1')))).toThrow(
        /focus\.csv: Lines 2-2:/,
      );
    },
  );

  it.each([
    row(baseline, '1').replace('2026-08-01', '2026-02-30'),
    row(baseline, '1').replace('2026-08-01', 'not-a-date'),
    row(baseline, '1').replace('2026-09-01', '2026-07-01'),
    row(baseline, '1').replace('BRL', 'brl'),
    row(baseline, '1').replace('Compute', ''),
    row(baseline, '1').replace('Compute', 'Com"pute'),
    row(baseline, '1').replace('Compute', '"unterminated'),
    row(baseline, '1').replace('Compute', '"Compute"suffix'),
  ])('fails closed with source context for malformed dates, scope or CSV', (invalid) => {
    expect(() => analyze(csv(invalid, row(current, '2')))).toThrow('focus.csv:');
  });

  it('groups on billing period rather than retroactively attributing corrections to consumption', () => {
    const result = analyze(
      `${HEADER},ChargePeriodStart\n` +
        `${row(baseline, '10')},2026-06-01\n${row(current, '-2')},2026-06-01`,
    );
    expect(result.currencies[0]!.delta).toBe('-12.00');
    expect(result.evidence.map((entry) => entry.period)).toEqual([baseline, current]);
  });
});

describe('investigation HTML', () => {
  it('renders exact evidence and a synthetic explanation without scripts or remote assets', () => {
    const report = generateInvestigationReport(analyze(INVESTIGATION_DEMO.csv), true);
    expect(report).toContain('DEMONSTRAÇÃO');
    expect(report).toContain('BRL 830.00');
    expect(report).toContain('USD 2.00');
    expect(report).toContain('href="#source-1-record-2"');
    expect(report).toContain('id="source-1-record-2"');
    expect(report).toContain('não infere causa técnica');
    expect(report).toContain('Efeito quantidade');
    expect(report).toContain('BRL 200.00');
    expect(report).toContain('BRL 250.00');
    expect(report).toContain('Evidência insuficiente');
    expect(report).not.toMatch(/<script|https?:\/\/|fetch\(/);
  });

  it('escapes untrusted filenames and CSV content and excludes unused sensitive fields', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const result = service.analyze(
      [
        {
          name: `${hostile}.csv`,
          content: `${HEADER},Tags\n${row(baseline, '1').replace('Compute', hostile)},private-tag-value\n${row(current, '2')},private-tag-value`,
        },
      ],
      baseline,
      current,
    );
    const report = generateInvestigationReport(result);
    expect(report).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(report).not.toContain('<img');
    expect(JSON.stringify(result)).not.toContain('private-tag-value');
    expect(report).not.toContain('private-tag-value');
  });
});
