import type { IdleResource, Recommendation } from '@/models';
import { CashCaptureService } from '@/services/cash-capture';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { mockIdleResources, mockRecommendations } from '../fixtures/mock-data';

const root = '/subscriptions/sub/resourceGroups/rg/providers/';
const planId = root + 'Microsoft.Web/serverFarms/plan';
const diskId = root + 'Microsoft.Compute/disks/disk';
const date = '2026-10-15T12:00:00Z';
const makeIdle = (id = diskId, type = 'Microsoft.Compute/disks', units?: string[]): IdleResource => ({
  ...mockIdleResources[0]!,
  resource: {
    ...mockIdleResources[0]!.resource, id, type, name: id.split('/').at(-1)!,
    ...(units ? { billingResourceIds: units } : {}),
  },
  evidence: {
    observationWindowDays: 30, dataPoints: 30, metrics: [],
    savingsBasis: 'observed-cost', savingsBasisDetail: 'Fatura.', confidence: 'high',
    billed: {
      observedTotal: 100, currency: 'BRL', monthly: { '2026-09': 100 },
      latestMonth: '2026-09', billingStopped: false, coveredMonths: ['2026-09'],
    },
  },
});
const rec = (idle: IdleResource, id = 'rec', amount = 80): Recommendation => ({
  ...mockRecommendations[0]!, id, resourceId: idle.resource.id, type: idle.resource.type,
  monthlySavings: amount, annualSavings: amount * 12,
  billingRationale: {
    billingModel: 'Cobrança por unidade.', whySaves: 'Reduz a unidade cobrada.',
    documentationUrl: 'https://learn.microsoft.com/azure/',
  },
});
const ledger = (resources: Record<string, Record<string, number>>, currency = 'BRL'): ResourceCostLedger => ({
  currency, months: ['2026-09'], coveredMonths: ['2026-09'], resources,
});
const service = new CashCaptureService();

describe('CashCaptureService', () => {
  it('caps a conditional estimate at closed-month cost without claiming confirmed payment reduction', () => {
    const idle = makeIdle();
    const plan = service.build([rec(idle, 'rec', 150)], [idle], date, 'USD');
    expect(plan.grossEstimateByCurrency).toEqual({ BRL: 150 });
    expect(plan.conditionalEstimateByCurrency).toEqual({ BRL: 100 });
    expect(plan.items[0]?.status).toBe('conditional');
    expect(plan.limitations.join(' ')).toContain('não é redução de pagamento confirmada');
    expect(plan.items[0]?.captureConditions.join(' ')).toContain('Savings Plan');
    expect(plan.items[0]?.verificationCriteria.join(' ')).toContain('origem e destino');
  });

  it('does not sum sites and their shared plan, matching ARM IDs case-insensitively', () => {
    const a = makeIdle(root + 'Microsoft.Web/sites/a', 'Microsoft.Web/sites', [planId.toUpperCase()]);
    const b = makeIdle(root + 'Microsoft.Web/sites/b', 'Microsoft.Web/sites', [planId]);
    const p = makeIdle(planId, 'Microsoft.Web/serverFarms');
    const result = service.build(
      [rec(a, 'a', 80), rec(b, 'b', 90), rec(p, 'p', 120)], [a, b, p], date, 'BRL',
      new Map([['sub', ledger({ [planId.toLowerCase()]: { '2026-09': 100 } })]]),
    );
    expect(result.conditionalEstimateByCurrency).toEqual({ BRL: 100 });
    expect(result.overlapExcludedByCurrency).toEqual({ BRL: 170 });
    expect(result.items.filter((item) => item.status === 'overlap')).toHaveLength(2);
    expect(result.items[0]?.overlapsWith).toHaveLength(2);
    expect(result.items[0]?.captureConditions.join(' ')).toContain('parar ou mover apenas o site');
  });

  it('groups transitive overlaps and keeps only one alternative regardless of input order', () => {
    const a = makeIdle('a', 'Microsoft.Compute/disks', ['x']);
    const b = makeIdle('b', 'Microsoft.Compute/disks', ['x', 'y']);
    const c = makeIdle('c', 'Microsoft.Compute/disks', ['y']);
    const ledgers = new Map([['sub', ledger({ x: { '2026-09': 100 }, y: { '2026-09': 100 } })]]);
    // Real ARM resource IDs are required to select a subscription ledger.
    for (const idle of [a, b, c]) idle.resource.id = root + 'Microsoft.Compute/disks/' + idle.resource.id;
    const recommendations = [rec(a, 'a', 50), rec(b, 'b', 80), rec(c, 'c', 60)];
    const first = service.build(recommendations, [a, b, c], date, 'BRL', ledgers);
    const reversed = service.build([...recommendations].reverse(), [a, b, c], date, 'BRL', ledgers);
    expect(first.conditionalEstimateByCurrency).toEqual({ BRL: 80 });
    expect(reversed.conditionalEstimateByCurrency).toEqual(first.conditionalEstimateByCurrency);
    expect(first.items.every((item) => item.overlapsWith.length === 2)).toBe(true);
  });

  it.each(['Microsoft.Web/sites', 'Microsoft.Sql/servers/databases'])(
    'does not infer shared billing relationships for %s', (type) => {
      const idle = makeIdle(root + type + '/same-name', type);
      const result = service.build([rec(idle)], [idle], date, 'BRL');
      expect(result.items[0]?.status).toBe('unquantified');
      expect(result.items[0]?.billingResourceIds).toEqual([]);
      expect(result.conditionalEstimateByCurrency).toEqual({});
    },
  );

  it('measures stopped VM opportunities against disks, not historical compute charges', () => {
    const idle = makeIdle(root + 'Microsoft.Compute/virtualMachines/stopped', 'Microsoft.Compute/virtualMachines', [diskId]);
    const result = service.build(
      [{ ...rec(idle), actionType: 'CLEANUP' }], [idle], date, 'BRL',
      new Map([['sub', ledger({ [diskId.toLowerCase()]: { '2026-09': 25 } })]]),
    );
    expect(result.conditionalEstimateByCurrency).toEqual({ BRL: 25 });
    expect(result.items[0]?.captureConditions.join(' ')).toContain('já não cobra computação');
  });

  it('requires reducing the pool reservation, not just shrinking an individual SQL database', () => {
    const poolId = root + 'Microsoft.Sql/servers/host/elasticPools/pool';
    const idle = makeIdle(root + 'Microsoft.Sql/servers/host/databases/db', 'Microsoft.Sql/servers/databases', [poolId]);
    const result = service.build(
      [rec(idle)], [idle], date, 'BRL',
      new Map([['sub', ledger({ [poolId.toLowerCase()]: { '2026-09': 100 } })]]),
    );
    expect(result.items[0]?.status).toBe('conditional');
    expect(result.items[0]?.captureConditions.join(' ')).toContain('reserva do pool');
  });

  it('does not treat absent billing entries, credits or incomplete coverage as a measured opportunity', () => {
    const idle = makeIdle();
    for (const data of [
      ledger({}),
      ledger({ [diskId.toLowerCase()]: { '2026-09': -10 } }),
      { ...ledger({ [diskId.toLowerCase()]: { '2026-09': 100 } }), coveredMonths: [] },
    ]) {
      const result = service.build([rec(idle)], [idle], date, 'BRL', new Map([['sub', data]]));
      expect(result.conditionalEstimateByCurrency).toEqual({});
    }
  });

  it('requires a closed month with the seven-day comparison buffer', () => {
    const idle = makeIdle();
    for (const when of ['2026-10-03T12:00:00Z', 'invalid-date']) {
      const result = service.build([rec(idle)], [idle], when, 'BRL');
      expect(result.conditionalEstimateByCurrency).toEqual({});
      expect(result.items[0]?.status).toBe('unquantified');
    }
  });

  it('does not quantify unsupported billing models or scheduling App Service shutdown', () => {
    const unsupported = makeIdle(root + 'Microsoft.Network/loadBalancers/lb', 'Microsoft.Network/loadBalancers');
    const app = makeIdle(root + 'Microsoft.Web/sites/site', 'Microsoft.Web/sites', [planId]);
    const result = service.build(
      [rec(unsupported, 'lb'), { ...rec(app, 'app'), actionType: 'SCHEDULE' }], [unsupported, app], date, 'BRL',
      new Map([['sub', ledger({
        [unsupported.resource.id.toLowerCase()]: { '2026-09': 100 },
        [planId.toLowerCase()]: { '2026-09': 100 },
      })]]),
    );
    expect(result.items.every((item) => item.status === 'unquantified')).toBe(true);
    expect(result.conditionalEstimateByCurrency).toEqual({});
  });

  it('keeps currencies separate and blocks conflicting currencies on shared units', () => {
    const brl = makeIdle();
    const usd = makeIdle(diskId + '-usd');
    usd.evidence!.billed!.currency = 'USD';
    const separate = service.build([rec(brl, 'brl'), rec(usd, 'usd')], [brl, usd], date, 'BRL');
    expect(separate.conditionalEstimateByCurrency).toEqual({ BRL: 80, USD: 80 });
    usd.resource.billingResourceIds = [diskId];
    const shared = service.build([rec(brl, 'brl'), rec(usd, 'usd')], [brl, usd], date, 'BRL');
    expect(shared.conditionalEstimateByCurrency).toEqual({});
    expect(shared.items.every((item) => item.status === 'unquantified')).toBe(true);
  });

  it('excludes historical, completed, dismissed and weakly evidenced opportunities', () => {
    const historical = makeIdle();
    historical.evidence!.billed!.billingStopped = true;
    const weak = makeIdle(diskId + '-weak');
    weak.evidence!.savingsBasis = 'heuristic';
    const result = service.build([
      rec(historical, 'old'), rec(weak, 'weak'),
      { ...rec(weak, 'done'), status: 'completed' },
      { ...rec(weak, 'dismissed'), status: 'dismissed' },
    ], [historical, weak], date, 'BRL');
    expect(result.items.map((item) => item.status)).toEqual(['historical', 'unquantified']);
    expect(result.conditionalEstimateByCurrency).toEqual({});
  });
});
