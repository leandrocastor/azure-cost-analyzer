import type { Resource } from '@/models';
import { GovernanceReportService } from '@/services/governance-report';

const buildResource = (overrides: Partial<Resource> = {}): Resource => ({
  id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/virtualMachines/vm-1',
  name: 'vm-1',
  type: 'Microsoft.Compute/virtualMachines',
  resourceGroup: 'rg-a',
  location: 'brazilsouth',
  sku: 'Standard_D2s_v3',
  tags: {},
  status: 'Succeeded',
  ...overrides,
});

describe('GovernanceReportService', () => {
  it('reports full coverage when every resource has all governance tags', () => {
    const resources = [
      buildResource({ tags: { owner: 'time-a', environment: 'prod', costCenter: 'cc-1' } }),
      buildResource({ id: 'r2', name: 'vm-2', tags: { owner: 'time-a', environment: 'prod', costCenter: 'cc-1' } }),
    ];

    const report = new GovernanceReportService().buildReport(resources);

    expect(report.coverage.every((item) => item.missingPercent === 0)).toBe(true);
    expect(report.worstResourceGroups).toHaveLength(0);
    expect(report.summary).toContain('Todos os');
  });

  it('computes missing percent per tag dimension', () => {
    const resources = [
      buildResource({ tags: { owner: 'time-a' } }),
      buildResource({ id: 'r2', name: 'vm-2', tags: {} }),
    ];

    const report = new GovernanceReportService().buildReport(resources);

    const ownerCoverage = report.coverage.find((item) => item.tagKey === 'owner');
    expect(ownerCoverage?.missingCount).toBe(1);
    expect(ownerCoverage?.missingPercent).toBe(0.5);

    const environmentCoverage = report.coverage.find((item) => item.tagKey === 'environment');
    expect(environmentCoverage?.missingCount).toBe(2);
    expect(environmentCoverage?.missingPercent).toBe(1);
  });

  it('ranks resource groups by share of resources missing any governance tag', () => {
    const resources = [
      buildResource({ resourceGroup: 'rg-bad', tags: {} }),
      buildResource({ id: 'r2', name: 'vm-2', resourceGroup: 'rg-bad', tags: {} }),
      buildResource({ id: 'r3', name: 'vm-3', resourceGroup: 'rg-good', tags: { owner: 'a', environment: 'prod', costCenter: 'cc' } }),
    ];

    const report = new GovernanceReportService().buildReport(resources);

    expect(report.worstResourceGroups[0]?.resourceGroup).toBe('rg-bad');
    expect(report.worstResourceGroups[0]?.missingAnyTagPercent).toBe(1);
    expect(report.worstResourceGroups.some((entry) => entry.resourceGroup === 'rg-good')).toBe(false);
  });

  it('returns an empty report when there are no resources to inspect', () => {
    const report = new GovernanceReportService().buildReport([]);

    expect(report.resourcesInspected).toBe(0);
    expect(report.coverage).toHaveLength(0);
    expect(report.summary).toContain('Nenhum recurso');
  });
});
