import { Script } from 'node:vm';
import type { CostDiff } from '@/models';
import { ExecutiveSummaryService } from '@/services/executive-summary';
import { OwnershipService } from '@/services/ownership';
import { RemediationService } from '@/services/remediation';
import { REPORT_CLIENT_SCRIPT, generateStaticReport } from '@/dashboard/report';
import { mockCostSummary, mockIdleResources, mockRecommendations } from '../fixtures/mock-data';

describe('generateStaticReport', () => {
  const baseData = {
    generatedAt: '2026-03-31T12:00:00.000Z',
    subscriptionId: 'sub-id',
    costs: mockCostSummary,
    idleResources: mockIdleResources,
    recommendations: mockRecommendations,
  };

  it('embeds a self-contained document with no external network calls', () => {
    const html = generateStaticReport(baseData);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).not.toContain('fetch(');
    expect(html).toContain('id="report-data"');
  });

  it('renders the interface in Brazilian Portuguese', () => {    const html = generateStaticReport(baseData);
    expect(html).toContain('lang="pt-BR"');
    expect(html).toContain('Relatório do Azure Cost Analyzer');
    expect(html).toContain('Custo Total');
    expect(html).toContain('Recursos Ociosos');
    expect(html).toContain('Recomendações');
    expect(html).toContain('Economia Anual Potencial');
    expect(html).toContain('Distribuição de Custos');
    // Nomes de recursos e serviços do Azure permanecem em inglês.
    expect(html).toContain('Resource Group');
    expect(html).toContain('Location');
  });

  it('embeds the cost summary, idle resources, and recommendations as JSON', () => {
    const html = generateStaticReport(baseData);
    expect(html).toContain('"totalAmount":1105');
    expect(html).toContain('"subscriptionId":"sub-id"');
    expect(html).toContain(mockIdleResources[0]?.resource.name ?? '');
    expect(html).toContain(mockRecommendations[0]?.title ?? '');
  });

  it('escapes angle brackets and ampersands when embedding data to prevent script injection', () => {
    const maliciousResource = {
      ...mockIdleResources[0]!,
      resource: {
        ...mockIdleResources[0]!.resource,
        name: '</script><img src=x onerror=alert(1)>&"\'',
      },
    };
    const html = generateStaticReport({
      ...baseData,
      idleResources: [maliciousResource],
    });

    expect(html).not.toContain('</script><img src=x onerror=alert(1)>');
    expect(html).toContain('\\u003c/script\\u003e');
  });

  it('computes annual savings opportunity from recommendations', () => {
    const html = generateStaticReport(baseData);
    const expectedAnnualSavings = mockRecommendations.reduce((sum, item) => sum + item.annualSavings, 0);
    expect(html).toContain(`"annualSavingsOpportunity":${expectedAnnualSavings}`);
  });

  it('includes a client-side escape helper used before innerHTML interpolation', () => {
    const html = generateStaticReport(baseData);
    expect(html).toContain('const esc = (value)');
    expect(html).toContain('esc(res.name');
    expect(html).toContain('esc(r.title');
  });
});

describe('generateStaticReport — seções de diferenciação', () => {
  const ownership = new OwnershipService().buildReport(mockIdleResources);
  const remediationPlans = new RemediationService().buildPlans(mockRecommendations, mockIdleResources);
  const executiveSummary = new ExecutiveSummaryService().build({
    costs: mockCostSummary,
    idleResources: mockIdleResources,
    recommendations: mockRecommendations,
    ownership,
    subscriptionCount: 1,
  });
  const diff: CostDiff = {
    previousGeneratedAt: '2026-02-28T12:00:00.000Z',
    previousPeriod: 'fev',
    currentPeriod: 'mar',
    totalPrevious: 1000,
    totalCurrent: 1105,
    totalDelta: 105,
    totalPercentChange: 10.5,
    currency: 'USD',
    byService: [{ key: 'Database', previous: 700, current: 770, delta: 70, percentChange: 10 }],
    byResourceGroup: [],
    idleCountPrevious: 3,
    idleCountCurrent: 2,
    newIdleResources: ['vm-nova'],
    resolvedIdleResources: ['vm-antiga'],
  };

  const fullData = {
    generatedAt: '2026-03-31T12:00:00.000Z',
    subscriptionId: 'sub-id',
    costs: mockCostSummary,
    idleResources: mockIdleResources,
    recommendations: mockRecommendations,
    executiveSummary,
    ownership,
    diff,
    remediationPlans,
  };

  it('renders the executive summary, ownership, diff and remediation sections', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('Sumário executivo');
    expect(html).toContain('Comparativo com a Execução Anterior');
    expect(html).toContain('Desperdício por Responsável');
    expect(html).toContain('Plano de Remediação');
  });

  it('embeds the new payloads so the sections have data to render', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"executiveSummary"');
    expect(html).toContain('"ownership"');
    expect(html).toContain('"diff"');
    expect(html).toContain('"remediationPlans"');
    expect(html).toContain('az vm resize');
  });

  it('keeps the optional sections hidden when their data is absent', () => {
    const html = generateStaticReport({
      generatedAt: '2026-03-31T12:00:00.000Z',
      subscriptionId: 'sub-id',
      costs: mockCostSummary,
      idleResources: mockIdleResources,
      recommendations: mockRecommendations,
    });

    expect(html).toContain('"executiveSummary":null');
    expect(html).toContain('"diff":null');
    expect(html).toContain('id="diff-section" hidden');
    expect(html).toContain('id="remediation-section" hidden');
  });

  it('produces syntactically valid inline JavaScript', () => {
    expect(REPORT_CLIENT_SCRIPT.length).toBeGreaterThan(0);
    expect(generateStaticReport(fullData)).toContain(REPORT_CLIENT_SCRIPT);
    // Compiling the source surfaces syntax errors without executing any of it.
    expect(() => new Script(REPORT_CLIENT_SCRIPT)).not.toThrow();
  });
  it('renders the Well-Architected scorecard and the cost of inaction', () => {
    const html = generateStaticReport({
      ...fullData,
      waf: {
        score: 72,
        grade: 'C',
        summary: 'Governança de custos parcialmente madura.',
        checks: [
          {
            id: 'CO:05',
            title: 'Proporção de desperdício',
            status: 'partial',
            weight: 20,
            score: 12,
            detail: '8% do gasto está em recursos ociosos.',
            recommendation: 'Elimine os recursos ociosos identificados.',
          },
        ],
      },
      inaction: {
        comparedTo: '2026-01-01T00:00:00.000Z',
        daysBetween: 90,
        stale: [
          {
            resourceId: '/subscriptions/sub/disks/disk-a',
            resourceName: 'disk-a',
            title: 'Disco não está anexado a nenhuma VM',
            monthlySavings: 30,
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            daysOpen: 90,
            wastedSoFar: 90,
          },
        ],
        resolved: 2,
        totalWasted: 90,
        projectedAnnualWaste: 360,
        summary: '1 recomendação continua em aberto há 90 dias.',
      },
    });

    expect(html).toContain('"grade":"C"');
    expect(html).toContain('"wastedSoFar":90');
    expect(html).toContain('Well-Architected');
  });

  it('keeps the scorecard and the inaction sections hidden without a baseline', () => {
    const html = generateStaticReport(fullData);

    // The sections start hidden and are only revealed client-side when data exists.
    expect(html).toContain('"waf":null');
    expect(html).toContain('"inaction":null');
    expect(html).toContain('id="waf-section" hidden');
    expect(html).toContain('id="inaction-section" hidden');
  });

  it('renders the FinOps Decision Engine classification', () => {
    const html = generateStaticReport({
      ...fullData,
      decisionEngine: {
        decisions: [
          {
            recommendationId: 'rec-1',
            resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan-empty',
            resourceName: 'plan-empty',
            category: 'EXECUTAVEL_AGORA',
            savingsStatus: 'provavel',
            monthlySavings: 219,
            reasoning: 'Achado de configuração com alta confiança.',
          },
        ],
        confirmedMonthlySavings: 0,
        probableMonthlySavings: 219,
        unconfirmedMonthlySavings: 0,
        executableNowCount: 1,
        summary: '1 recomendação(ões) prontas para execução imediata.',
      },
    });

    expect(html).toContain('"category":"EXECUTAVEL_AGORA"');
    expect(html).toContain('FinOps Decision Engine');
    expect(html).toContain('"executableNowCount":1');
  });

  it('keeps the decision engine section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"decisionEngine":null');
    expect(html).toContain('id="decision-section" hidden');
  });

  it('renders the aging and ownerless resources section', () => {
    const html = generateStaticReport({
      ...fullData,
      aging: {
        resources: [
          {
            resourceId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-old',
            resourceName: 'vm-old',
            resourceType: 'Microsoft.Compute/virtualMachines',
            resourceGroup: 'rg',
            createdAt: '2024-01-01T00:00:00Z',
            ageDays: 600,
            monthlyCost: 340,
            currency: 'BRL',
            isIdle: false,
          },
        ],
        totalMonthlyCostAtRisk: 340,
        oldestResourceAgeDays: 600,
        resourcesInspected: 10,
        resourcesWithConfirmedAge: 5,
        summary: '1 recurso(s) com mais de 180 dias, sem tag de responsável e com custo faturado confirmado, somando 340.00 BRL/mês em risco de governança.',
      },
    });

    expect(html).toContain('"ageDays":600');
    expect(html).toContain('Recursos Envelhecidos e Sem Dono');
    expect(html).toContain('"totalMonthlyCostAtRisk":340');
  });

  it('keeps the aging section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"aging":null');
    expect(html).toContain('id="aging-section" hidden');
  });

  it('renders the forgotten non-production environments section', () => {
    const html = generateStaticReport({
      ...fullData,
      forgottenEnvironments: {
        resources: [
          {
            resourceId: '/subscriptions/sub/resourceGroups/rg-dev/providers/Microsoft.Compute/virtualMachines/vm-test',
            resourceName: 'vm-test',
            resourceType: 'Microsoft.Compute/virtualMachines',
            resourceGroup: 'rg-dev',
            matchedPattern: 'test',
            matchedOn: 'name',
            createdAt: '2024-01-01T00:00:00Z',
            ageDays: 500,
            monthlyCost: 200,
            currency: 'BRL',
            isIdle: false,
          },
        ],
        totalMonthlyCostAtRisk: 200,
        resourcesInspected: 20,
        resourcesWithConfirmedAge: 15,
        summary: '1 ambiente não produtivo esquecido encontrado.',
      },
    });

    expect(html).toContain('"matchedPattern":"test"');
    expect(html).toContain('Ambientes Não Produtivos Esquecidos');
  });

  it('keeps the forgotten environments section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"forgottenEnvironments":null');
    expect(html).toContain('id="forgotten-env-section" hidden');
  });

  it('renders the governance report section', () => {
    const html = generateStaticReport({
      ...fullData,
      governance: {
        resourcesInspected: 10,
        coverage: [
          { tagKey: 'owner', label: 'Responsável (owner)', presentCount: 6, missingCount: 4, missingPercent: 0.4 },
        ],
        worstResourceGroups: [
          { resourceGroup: 'rg-dev', resourceCount: 5, missingAnyTagCount: 3, missingAnyTagPercent: 0.6 },
        ],
        summary: '40% dos 10 recurso(s) inspecionados não têm a tag de responsável.',
      },
    });

    expect(html).toContain('Governança de Tags');
    expect(html).toContain('"resourcesInspected":10');
  });

  it('keeps the governance section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"governance":null');
    expect(html).toContain('id="governance-section" hidden');
  });

  it('renders the unit economics section', () => {
    const html = generateStaticReport({
      ...fullData,
      unitEconomics: {
        groupTagKey: 'app',
        entries: [{ key: 'checkout-api', monthlyCost: 500, resourceCount: 3, shareOfTaggedTotal: 1 }],
        taggedMonthlyCost: 500,
        untaggedMonthlyCost: 100,
        untaggedResourceCount: 2,
        summary: 'R$ 500,00/mês atribuídos via tag "app".',
      },
    });

    expect(html).toContain('Unit Economics');
    expect(html).toContain('"groupTagKey":"app"');
  });

  it('keeps the unit economics section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"unitEconomics":null');
    expect(html).toContain('id="unit-economics-section" hidden');
  });

  it('renders the FinOps maturity score section', () => {
    const html = generateStaticReport({
      ...fullData,
      maturityScore: {
        score: 62,
        grade: 'C',
        dimensions: [
          {
            name: 'Otimização de custos (WAF Cost Optimization)',
            score: 70,
            weight: 0.35,
            evidence: '7 de 10 verificações WAF atendidas.',
          },
        ],
        summary: 'Maturidade FinOps intermediária (nota C, 62/100).',
      },
    });

    expect(html).toContain('FinOps Maturity Score');
    expect(html).toContain('"grade":"C"');
  });

  it('keeps the maturity score section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"maturityScore":null');
    expect(html).toContain('id="maturity-section" hidden');
  });

  it('renders the cost anomalies section with root cause', () => {
    const html = generateStaticReport({
      ...fullData,
      anomalies: [
        {
          date: '2026-07',
          amount: 18500,
          expectedAmount: 12000,
          deviation: 2.8,
          severity: 'high',
          rootCauses: [
            {
              dimension: 'service',
              key: 'Virtual Machines',
              amountOnAnomalyDate: 9000,
              averageAmount: 5000,
              deltaAmount: 4000,
              shareOfTotalDelta: 0.62,
            },
          ],
        },
      ],
    });

    expect(html).toContain('Anomalias de Custo com Causa Raiz');
    expect(html).toContain('"deviation":2.8');
  });

  it('keeps the anomalies section hidden without data', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('"anomalies":[]');
    expect(html).toContain('id="anomalies-section" hidden');
  });

  it('exposes the evidence that supports each idle finding', () => {
    const html = generateStaticReport({
      ...fullData,
      idleResources: [
        {
          ...mockIdleResources[0]!,
          evidence: {
            observationWindowDays: 30,
            dataPoints: 720,
            metrics: [{ label: 'CPU média', value: 1.2, unit: '%' }],
            savingsBasis: 'retail-price',
            savingsBasisDetail: 'Preço de lista Azure para P10 LRS Disk.',
            confidence: 'high',
          },
        },
      ],
    });

    expect(html).toContain('"savingsBasis":"retail-price"');
    expect(html).toContain('"confidence":"high"');
    expect(html).toContain('"observationWindowDays":30');
  });
  it('wraps every table in a horizontal scroll container so wide content is never clipped', () => {
    const html = generateStaticReport(fullData);
    const wrappers = html.match(/table-scroll/g) ?? [];

    // 1 declaracao no CSS + 5 tabelas envolvidas no script cliente.
    expect(wrappers.length).toBeGreaterThanOrEqual(6);
    expect(html).not.toMatch(/innerHTML = '<table>'/);
  });

  it('ships a print stylesheet so the report can be exported to PDF', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain('@media print');
  });

  it('formats currency using the currency reported by Azure instead of a hardcoded symbol', () => {
    const html = generateStaticReport(fullData);

    expect(html).toContain("style: 'currency'");
    expect(html).not.toContain("'$' + n.toLocaleString");
  });
});
