import { generateStaticReport } from '@/dashboard/report';
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

  it('renders the interface in Brazilian Portuguese', () => {
    const html = generateStaticReport(baseData);
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
