import type { AgingReport, ForgottenEnvironmentReport, GovernanceReport, WafScorecard } from '@/models';
import { FinOpsMaturityScoreService } from '@/services/finops-maturity';

const buildWaf = (score: number): WafScorecard => ({
  score,
  grade: 'B',
  checks: [],
  summary: 'resumo',
  subscriptionCount: 1,
  evaluatedAt: new Date().toISOString(),
});

const buildGovernance = (overrides: Partial<GovernanceReport> = {}): GovernanceReport => ({
  resourcesInspected: 100,
  coverage: [
    { tagKey: 'owner', label: 'Responsável (owner)', presentCount: 100, missingCount: 0, missingPercent: 0 },
    { tagKey: 'environment', label: 'Ambiente (environment)', presentCount: 100, missingCount: 0, missingPercent: 0 },
    { tagKey: 'costCenter', label: 'Centro de custo (costCenter)', presentCount: 100, missingCount: 0, missingPercent: 0 },
  ],
  worstResourceGroups: [],
  summary: 'resumo',
  ...overrides,
});

const buildAging = (resourceCount: number): AgingReport => ({
  resources: Array.from({ length: resourceCount }, (_, index) => ({
    resourceId: `r${index}`,
    resourceName: `r${index}`,
    resourceType: 'Microsoft.Compute/virtualMachines',
    resourceGroup: 'rg-a',
    createdAt: new Date().toISOString(),
    ageDays: 400,
    monthlyCost: 10,
    currency: 'BRL',
    isIdle: false,
  })),
  totalMonthlyCostAtRisk: resourceCount * 10,
  oldestResourceAgeDays: 400,
  resourcesInspected: 100,
  resourcesWithConfirmedAge: 100,
  summary: 'resumo',
});

const buildForgottenEnv = (resourceCount: number): ForgottenEnvironmentReport => ({
  resources: Array.from({ length: resourceCount }, (_, index) => ({
    resourceId: `f${index}`,
    resourceName: `f${index}`,
    resourceType: 'Microsoft.Compute/virtualMachines',
    resourceGroup: 'rg-dev',
    matchedPattern: 'test',
    matchedOn: 'name',
    createdAt: new Date().toISOString(),
    ageDays: 120,
    monthlyCost: 10,
    currency: 'BRL',
    isIdle: false,
  })),
  totalMonthlyCostAtRisk: resourceCount * 10,
  resourcesInspected: 100,
  resourcesWithConfirmedAge: 100,
  summary: 'resumo',
});

describe('FinOpsMaturityScoreService', () => {
  it('scores a perfectly governed, fully optimized estate close to 100', () => {
    const score = new FinOpsMaturityScoreService().build({
      waf: buildWaf(100),
      governance: buildGovernance(),
      aging: buildAging(0),
      forgottenEnvironments: buildForgottenEnv(0),
    });

    expect(score.score).toBe(100);
    expect(score.grade).toBe('A');
    expect(score.dimensions).toHaveLength(4);
  });

  it('penalizes missing owner tag coverage', () => {
    const goodScore = new FinOpsMaturityScoreService().build({
      waf: buildWaf(100),
      governance: buildGovernance(),
      aging: buildAging(0),
      forgottenEnvironments: buildForgottenEnv(0),
    });

    const badScore = new FinOpsMaturityScoreService().build({
      waf: buildWaf(100),
      governance: buildGovernance({
        coverage: [
          { tagKey: 'owner', label: 'Responsável (owner)', presentCount: 0, missingCount: 100, missingPercent: 1 },
          { tagKey: 'environment', label: 'Ambiente (environment)', presentCount: 100, missingCount: 0, missingPercent: 0 },
          { tagKey: 'costCenter', label: 'Centro de custo (costCenter)', presentCount: 100, missingCount: 0, missingPercent: 0 },
        ],
      }),
      aging: buildAging(0),
      forgottenEnvironments: buildForgottenEnv(0),
    });

    expect(badScore.score).toBeLessThan(goodScore.score);
  });

  it('penalizes a higher proportion of aging and forgotten-environment findings', () => {
    const score = new FinOpsMaturityScoreService().build({
      waf: buildWaf(100),
      governance: buildGovernance(),
      aging: buildAging(20),
      forgottenEnvironments: buildForgottenEnv(10),
    });

    expect(score.score).toBeLessThan(100);
    expect(score.dimensions.find((d) => d.name.includes('envelhecidos'))?.score).toBeCloseTo(70, 0);
  });

  it('assigns grade E to a very low score', () => {
    const score = new FinOpsMaturityScoreService().build({
      waf: buildWaf(10),
      governance: buildGovernance({
        coverage: [
          { tagKey: 'owner', label: 'Responsável (owner)', presentCount: 0, missingCount: 100, missingPercent: 1 },
          { tagKey: 'environment', label: 'Ambiente (environment)', presentCount: 0, missingCount: 100, missingPercent: 1 },
          { tagKey: 'costCenter', label: 'Centro de custo (costCenter)', presentCount: 0, missingCount: 100, missingPercent: 1 },
        ],
      }),
      aging: buildAging(50),
      forgottenEnvironments: buildForgottenEnv(50),
    });

    expect(score.grade).toBe('E');
  });
});
