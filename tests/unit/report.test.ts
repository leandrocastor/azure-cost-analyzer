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
});
