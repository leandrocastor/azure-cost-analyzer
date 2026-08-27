import { OptimizerService } from '@/services/optimizer';
import { mockIdleResources, mockResource } from '../fixtures/mock-data';

describe('OptimizerService', () => {
  const service = new OptimizerService();

  it('generates recommendations', async () => {
    const recommendations = await service.generateRecommendations(mockIdleResources);
    expect(recommendations).toHaveLength(2);
  });

  it('prioritizes recommendations by roi', async () => {
    const recommendations = await service.generateRecommendations(mockIdleResources);
    expect(recommendations[0]!.roi).toBeGreaterThanOrEqual(recommendations[1]!.roi);
  });

  it('calculates roi', () => {
    expect(service.calculateROI({ monthlySavings: 100, annualSavings: 1200, risk: 'low', effort: 'low' } as never)).toBe(12);
  });

  it.each([
    ['Microsoft.Compute/virtualMachines', 'DOWNSIZE'],
    ['Microsoft.Storage/storageAccounts', 'DELETE'],
    ['Microsoft.Sql/servers/databases', 'CHANGE_SKU'],
  ])('assesses medium or high risk based on resource type %s', (type, _actionType) => {
    const risk = service.assessRisk({ ...mockResource, type } as typeof mockResource, type === 'Microsoft.Storage/storageAccounts' ? 'DELETE' : 'CHANGE_SKU');
    expect(['low', 'medium', 'high']).toContain(risk);
  });

  it('raises high risk for delete actions', () => {
    expect(service.assessRisk(mockResource, 'DELETE')).toBe('high');
  });

  it('raises high risk for critical resources', () => {
    expect(service.assessRisk({ ...mockResource, tags: { criticality: 'high' } }, 'DOWNSIZE')).toBe('high');
  });

  it.each([
    ['DELETE', 'low'],
    ['CLEANUP', 'low'],
    ['SCHEDULE', 'medium'],
    ['DOWNSIZE', 'medium'],
    ['CHANGE_SKU', 'high'],
    ['MIGRATE', 'high'],
  ])('estimates %s effort as %s', (actionType, effort) => {
    expect(service.estimateEffort(actionType as 'DELETE')).toBe(effort);
  });

  it('calculates savings with type and sku adjustments', () => {
    expect(service.calculateMonthlySavings({ ...mockResource, sku: 'Premium' })).toBeGreaterThan(150);
  });

  it('uses baseline when higher than heuristic', () => {
    expect(service.calculateMonthlySavings(mockResource, 500)).toBeGreaterThanOrEqual(500);
  });

  it('sorts custom recommendations by roi', () => {
    const ordered = service.prioritize([
      { roi: 1 },
      { roi: 3 },
      { roi: 2 },
    ] as never);
    expect(ordered.map((item) => item.roi)).toEqual([3, 2, 1]);
  });
});
