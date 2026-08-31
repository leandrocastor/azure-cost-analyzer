import type { IdleResource, Recommendation } from '@/models';
import { DecisionEngineService } from '@/services/decision-engine';

const baseResource = {
  id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-a',
  name: 'disk-a',
  type: 'Microsoft.Compute/disks',
  resourceGroup: 'rg',
  location: 'brazilsouth',
  sku: 'Premium_LRS',
  tags: {},
  status: 'Succeeded',
};

const buildIdle = (overrides: Partial<IdleResource> = {}): IdleResource => ({
  resource: baseResource,
  reason: 'Disco não anexado',
  idleScore: 90,
  estimatedMonthlySavings: 40,
  metrics: [],
  evidence: {
    observationWindowDays: 0,
    dataPoints: 0,
    metrics: [],
    savingsBasis: 'retail-price',
    savingsBasisDetail: 'Preço de lista',
    confidence: 'high',
  },
  ...overrides,
});

const buildRecommendation = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  id: 'rec-1',
  type: 'cleanup',
  resourceId: baseResource.id,
  title: 'Remover disco órfão',
  description: 'Disco sem VM associada',
  monthlySavings: 40,
  annualSavings: 480,
  risk: 'low',
  effort: 'low',
  roi: 12,
  actionType: 'CLEANUP',
  status: 'new',
  ...overrides,
});

describe('DecisionEngineService', () => {
  const service = new DecisionEngineService();

  it('classifies a confirmed, low-risk finding as executable now', () => {
    const idle = buildIdle({
      evidence: {
        observationWindowDays: 0,
        dataPoints: 0,
        metrics: [],
        savingsBasis: 'observed-cost',
        savingsBasisDetail: 'Capado pela fatura',
        confidence: 'high',
        billed: { observedTotal: 40, currency: 'USD', monthly: { '2026-08': 40 }, latestMonth: '2026-08', billingStopped: false },
      },
    });
    const report = service.evaluate([buildRecommendation()], [idle], 'USD');

    expect(report.decisions[0]?.category).toBe('EXECUTAVEL_AGORA');
    expect(report.decisions[0]?.savingsStatus).toBe('confirmada');
    expect(report.confirmedMonthlySavings).toBe(40);
    expect(report.executableNowCount).toBe(1);
  });

  it('classifies a high-confidence configuration finding without invoice match as executable now', () => {
    const report = service.evaluate([buildRecommendation()], [buildIdle()], 'USD');

    expect(report.decisions[0]?.category).toBe('EXECUTAVEL_AGORA');
    expect(report.decisions[0]?.savingsStatus).toBe('provavel');
    expect(report.probableMonthlySavings).toBe(40);
  });

  it('requires validation for a high-risk action even with strong evidence', () => {
    const report = service.evaluate([buildRecommendation({ risk: 'high' })], [buildIdle()], 'USD');

    expect(report.decisions[0]?.category).toBe('VALIDAR_ANTES');
  });

  it('requires validation for a medium-confidence finding', () => {
    const idle = buildIdle({
      evidence: {
        observationWindowDays: 7,
        dataPoints: 5,
        metrics: [],
        savingsBasis: 'retail-price',
        savingsBasisDetail: 'Preço de lista',
        confidence: 'medium',
      },
    });
    const report = service.evaluate([buildRecommendation()], [idle], 'USD');

    expect(report.decisions[0]?.category).toBe('VALIDAR_ANTES');
    expect(report.decisions[0]?.savingsStatus).toBe('provavel');
  });

  it('flags a low-confidence or heuristic finding for investigation', () => {
    const idle = buildIdle({
      evidence: {
        observationWindowDays: 7,
        dataPoints: 0,
        metrics: [],
        savingsBasis: 'heuristic',
        savingsBasisDetail: 'Estimativa média',
        confidence: 'low',
      },
    });
    const report = service.evaluate([buildRecommendation()], [idle], 'USD');

    expect(report.decisions[0]?.category).toBe('INVESTIGAR');
    expect(report.decisions[0]?.savingsStatus).toBe('nao-confirmada');
    expect(report.unconfirmedMonthlySavings).toBe(40);
  });

  it('marks a finding whose billing already stopped as historical only, with no savings to claim', () => {
    const idle = buildIdle({
      evidence: {
        observationWindowDays: 0,
        dataPoints: 0,
        metrics: [],
        savingsBasis: 'observed-cost',
        savingsBasisDetail: 'Cobrança encerrada',
        confidence: 'high',
        billed: { observedTotal: 100, currency: 'USD', monthly: { '2026-07': 100, '2026-08': 0 }, lastMonthWithCost: '2026-07', latestMonth: '2026-08', billingStopped: true },
      },
    });
    const report = service.evaluate([buildRecommendation({ monthlySavings: 0, annualSavings: 0 })], [idle], 'USD');

    expect(report.decisions[0]?.category).toBe('SOMENTE_HISTORICO');
    expect(report.decisions[0]?.reasoning).toContain('cobrança');
  });

  it('treats a recommendation with no matching idle resource as needing investigation', () => {
    const report = service.evaluate([buildRecommendation({ resourceId: 'unknown-resource' })], [], 'USD');

    expect(report.decisions[0]?.category).toBe('INVESTIGAR');
  });

  it('summarizes counts and totals across mixed categories', () => {
    const executableNow = buildIdle();
    const investigate = buildIdle({
      resource: { ...baseResource, id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/disk-b', name: 'disk-b' },
      evidence: {
        observationWindowDays: 0,
        dataPoints: 0,
        metrics: [],
        savingsBasis: 'heuristic',
        savingsBasisDetail: 'Estimativa média',
        confidence: 'low',
      },
    });

    const report = service.evaluate(
      [
        buildRecommendation({ id: 'rec-1', resourceId: executableNow.resource.id }),
        buildRecommendation({ id: 'rec-2', resourceId: investigate.resource.id, monthlySavings: 20, annualSavings: 240 }),
      ],
      [executableNow, investigate],
      'USD',
    );

    expect(report.summary).toContain('1 recomendação(ões) prontas para execução imediata');
    expect(report.summary).toContain('1 precisam de mais evidência');
    expect(report.probableMonthlySavings).toBe(40);
    expect(report.unconfirmedMonthlySavings).toBe(20);
  });
});
