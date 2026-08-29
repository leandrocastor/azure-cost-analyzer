import type { CostSummary, IdleResource, Recommendation, Resource, WafCheck } from '@/models';
import { WafScorecardService } from '@/services/waf-scorecard';

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  id: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/${overrides.name ?? 'vm'}`,
  name: 'vm',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg',
  location: 'brazilsouth',
  sku: 'Standard_D2s_v3',
  tags: {},
  status: 'Succeeded',
  ...overrides,
});

const buildIdle = (overrides: Partial<IdleResource> = {}): IdleResource => ({
  resource: buildResource(),
  reason: 'CPU baixa',
  idleScore: 90,
  estimatedMonthlySavings: 100,
  metrics: [],
  ...overrides,
});

const buildCosts = (overrides: Partial<CostSummary> = {}): CostSummary => ({
  period: '2026-06..2026-08',
  totalAmount: 10_000,
  currency: 'BRL',
  byService: { Compute: 6000, Storage: 4000 },
  byResourceGroup: { rg: 10_000 },
  byLocation: {},
  ...overrides,
});

const findCheck = (service: WafScorecardService, id: string, input: Parameters<WafScorecardService['evaluate']>[0]): WafCheck | undefined =>
  service.evaluate(input).checks.find((check) => check.id === id);

describe('WafScorecardService', () => {
  const service = new WafScorecardService();

  const baseInput = {
    costs: buildCosts(),
    idleResources: [] as IdleResource[],
    recommendations: [] as Recommendation[],
    resources: [] as Resource[],
    subscriptionCount: 1,
  };

  it('scores a clean tenant highly', () => {
    const result = service.evaluate({
      ...baseInput,
      resources: [buildResource({ tags: { owner: 'leandro', environment: 'prod' } })],
    });

    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.grade).toBe('A');
  });

  it('penalizes a tenant where waste is a large share of the spend', () => {
    const result = service.evaluate({
      ...baseInput,
      costs: buildCosts({ totalAmount: 1000 }),
      idleResources: [buildIdle({ estimatedMonthlySavings: 500 })],
    });

    const check = result.checks.find((item) => item.id === 'waste-ratio');
    expect(check?.status).toBe('fail');
    expect(check?.evidence).toContain('50,0%');
  });

  it('keeps the waste check applicable only when costs are known', () => {
    const check = findCheck(service, 'waste-ratio', {
      ...baseInput,
      costs: buildCosts({ totalAmount: 0, byService: {} }),
    });

    expect(check?.status).toBe('not-applicable');
  });

  it('excludes non-applicable checks from the score', () => {
    const withoutCosts = service.evaluate({
      ...baseInput,
      costs: buildCosts({ totalAmount: 0, byService: {} }),
    });

    // Every check still carries its weight, but the score only divides by the
    // applicable ones, so an unmeasurable control cannot silently lower the grade.
    expect(withoutCosts.score).toBeGreaterThan(0);
    expect(withoutCosts.checks.some((check) => check.status === 'not-applicable')).toBe(true);
  });

  it('measures owner tag coverage across the whole estate', () => {
    const check = findCheck(service, 'ownership-tagging', {
      ...baseInput,
      resources: [
        buildResource({ name: 'a', tags: { owner: 'leandro' } }),
        buildResource({ name: 'b', tags: {} }),
      ],
    });

    expect(check?.status).toBe('partial');
    expect(check?.evidence).toContain('50%');
  });

  it('honors custom owner tag keys', () => {
    const check = findCheck(service, 'ownership-tagging', {
      ...baseInput,
      ownerTagKeys: ['squad'],
      resources: [buildResource({ tags: { squad: 'plataforma' } })],
    });

    expect(check?.status).toBe('pass');
  });

  it('flags orphaned resources that keep being billed', () => {
    const check = findCheck(service, 'orphaned-resources', {
      ...baseInput,
      idleResources: [
        buildIdle({ resource: buildResource({ name: 'd1', type: 'Microsoft.Compute/disks' }) }),
      ],
    });

    expect(check?.status).toBe('partial');
    expect(check?.evidence).toContain('1 recurso');
  });

  it('flags underused resources backed by telemetry', () => {
    const check = findCheck(service, 'rightsizing', {
      ...baseInput,
      idleResources: [
        buildIdle({
          metrics: [{ resourceId: 'x', metricName: 'Percentage CPU', value: 2, unit: 'Percent', timestamp: '2026-01-01T00:00:00Z' }],
        }),
      ],
    });

    expect(check?.status).toBe('partial');
  });

  it('reports concentrated spend as an optimization target', () => {
    const check = findCheck(service, 'spend-concentration', {
      ...baseInput,
      costs: buildCosts({ byService: { Compute: 9000, Storage: 1000 } }),
    });

    expect(check?.status).toBe('partial');
    expect(check?.evidence).toContain('Compute');
  });

  it('assigns a lower grade as findings accumulate', () => {
    const poor = service.evaluate({
      ...baseInput,
      costs: buildCosts({ totalAmount: 1000, byService: { Compute: 1000 } }),
      idleResources: Array.from({ length: 6 }, (_, index) =>
        buildIdle({
          resource: buildResource({ name: `d${index}`, type: 'Microsoft.Compute/disks' }),
          estimatedMonthlySavings: 100,
        }),
      ),
      resources: [buildResource({ tags: {} })],
    });

    expect(poor.score).toBeLessThan(40);
    expect(poor.grade).toBe('E');
  });

  it('always reports every check with its evidence', () => {
    const result = service.evaluate(baseInput);

    expect(result.checks.length).toBeGreaterThanOrEqual(8);
    for (const check of result.checks) {
      expect(check.evidence.length).toBeGreaterThan(0);
      expect(check.recommendation.length).toBeGreaterThan(0);
      expect(check.code).toMatch(/^CO:\d+$/);
    }
  });

  it('records when the evaluation ran so runs can be compared', () => {
    const result = service.evaluate(baseInput);
    expect(Number.isNaN(Date.parse(result.evaluatedAt))).toBe(false);
  });
});
