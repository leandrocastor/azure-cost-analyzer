import { describe, expect, it } from 'vitest';

import type { IdleResource } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { CostReconciliationService } from '@/services/cost-reconciliation';

const buildIdle = (overrides: Partial<IdleResource> = {}): IdleResource => ({
  resource: {
    id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/app-free',
    name: 'app-free',
    type: 'Microsoft.Web/sites',
    resourceGroup: 'rg',
    location: 'brazilsouth',
    sku: 'F1',
    tags: {},
    status: 'Succeeded',
  },
  reason: 'Volume de requisições muito baixo',
  idleScore: 70,
  estimatedMonthlySavings: 120,
  metrics: [],
  evidence: {
    observationWindowDays: 7,
    dataPoints: 168,
    metrics: [],
    savingsBasis: 'retail-price',
    savingsBasisDetail: 'Preço de lista.',
    confidence: 'high',
  },
  ...overrides,
});

const ledgerFor = (
  resourceId: string,
  monthly: Record<string, number>,
  months: string[],
): ResourceCostLedger => ({
  currency: 'BRL',
  months,
  resources: { [resourceId.toLowerCase()]: monthly },
});

describe('CostReconciliationService', () => {
  const service = new CostReconciliationService();

  it('drops findings for resources that were never billed', () => {
    const idle = buildIdle();
    const ledger = ledgerFor(idle.resource.id, { '2026-06': 0, '2026-07': 0 }, ['2026-06', '2026-07']);

    const result = service.reconcile([idle], ledger);

    expect(result.idleResources).toHaveLength(0);
    expect(result.discarded).toHaveLength(1);
    expect(result.discarded[0]?.name).toBe('app-free');
  });

  it('treats residual fractions of a cent as no billing at all', () => {
    const idle = buildIdle();
    const ledger = ledgerFor(idle.resource.id, { '2026-06': 0.004, '2026-07': 0.001 }, ['2026-06', '2026-07']);

    const result = service.reconcile([idle], ledger);

    expect(result.idleResources).toHaveLength(0);
  });

  it('keeps a resource whose billing stopped, states it explicitly and claims no savings', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 300 });
    const ledger = ledgerFor(idle.resource.id, { '2026-05': 210.5, '2026-06': 0, '2026-07': 0 }, [
      '2026-05',
      '2026-06',
      '2026-07',
    ]);

    const result = service.reconcile([idle], ledger);
    const [reconciled] = result.idleResources;

    expect(result.stopped).toHaveLength(1);
    expect(result.stopped[0]?.lastMonthWithCost).toBe('2026-05');
    expect(reconciled?.estimatedMonthlySavings).toBe(0);
    expect(reconciled?.reason).toContain('sem custo faturado desde maio de 2026');
    expect(reconciled?.evidence?.savingsBasis).toBe('observed-cost');
    expect(reconciled?.evidence?.billed?.billingStopped).toBe(true);
  });

  it('caps the estimate at the cost actually billed in the latest month', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 596.34 });
    const ledger = ledgerFor(idle.resource.id, { '2026-06': 90, '2026-07': 88.4 }, ['2026-06', '2026-07']);

    const result = service.reconcile([idle], ledger);
    const [reconciled] = result.idleResources;

    expect(reconciled?.estimatedMonthlySavings).toBe(88.4);
    expect(reconciled?.evidence?.savingsBasis).toBe('observed-cost');
    expect(reconciled?.evidence?.savingsBasisDetail).toContain('limitada ao custo realmente faturado');
  });

  it('keeps an estimate that is already below the billed cost', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 40 });
    const ledger = ledgerFor(idle.resource.id, { '2026-07': 500 }, ['2026-07']);

    const result = service.reconcile([idle], ledger);
    const [reconciled] = result.idleResources;

    expect(reconciled?.estimatedMonthlySavings).toBe(40);
    expect(reconciled?.evidence?.savingsBasis).toBe('retail-price');
  });

  it('attaches the billed cost as an auditable metric', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 10 });
    const ledger = ledgerFor(idle.resource.id, { '2026-07': 33.75 }, ['2026-07']);

    const [reconciled] = service.reconcile([idle], ledger).idleResources;

    expect(reconciled?.evidence?.metrics).toContainEqual({
      label: 'Custo faturado em julho de 2026',
      value: 33.75,
      unit: 'BRL',
    });
  });

  it('flags findings absent from the cost data as unverified instead of dropping them', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 75 });
    const ledger = ledgerFor('/subscriptions/sub/providers/other', { '2026-07': 10 }, ['2026-07']);

    const [reconciled] = service.reconcile([idle], ledger).idleResources;

    expect(reconciled?.estimatedMonthlySavings).toBe(75);
    expect(reconciled?.evidence?.confidence).toBe('medium');
    expect(reconciled?.evidence?.caveat).toContain('Não foi possível localizar cobranças');
  });

  it('matches resource IDs regardless of casing differences between Azure APIs', () => {
    const idle = buildIdle({ estimatedMonthlySavings: 500 });
    const ledger = ledgerFor(idle.resource.id.toUpperCase(), { '2026-07': 12 }, ['2026-07']);

    const [reconciled] = service.reconcile([idle], ledger).idleResources;

    expect(reconciled?.estimatedMonthlySavings).toBe(12);
  });

  it('leaves findings untouched when there is no cost data to reconcile against', () => {
    const idle = buildIdle();
    const ledger: ResourceCostLedger = { currency: 'BRL', months: [], resources: {} };

    const result = service.reconcile([idle], ledger);

    expect(result.idleResources).toEqual([idle]);
    expect(result.discarded).toHaveLength(0);
  });
});
