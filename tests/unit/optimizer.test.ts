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
  describe('savings fidelity', () => {
    const pricedResource = {
      id: '/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Compute/disks/disk-a',
      name: 'disk-a',
      type: 'Microsoft.Compute/disks',
      resourceGroup: 'rg-a',
      location: 'brazilsouth',
      sku: 'Premium_LRS',
      tags: {},
      status: 'Succeeded',
    };

    it('publishes the resolved list price without inflating it', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        {
          resource: pricedResource,
          reason: 'Disco não está anexado a nenhuma VM',
          idleScore: 95,
          estimatedMonthlySavings: 174.93,
          metrics: [],
          evidence: {
            observationWindowDays: 0,
            dataPoints: 0,
            metrics: [],
            savingsBasis: 'retail-price',
            savingsBasisDetail: 'Preço de lista Azure para P10 LRS Disk',
            confidence: 'high',
          },
        },
      ]);

      // The heuristic used to turn this into 314.87 by taking a floor and then
      // applying a premium multiplier on top of an already exact number.
      expect(recommendation?.monthlySavings).toBe(174.93);
      expect(recommendation?.annualSavings).toBe(2099.16);
    });

    it('still estimates when no list price could be resolved', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        {
          resource: pricedResource,
          reason: 'Disco não está anexado a nenhuma VM',
          idleScore: 95,
          estimatedMonthlySavings: 30,
          metrics: [],
          evidence: {
            observationWindowDays: 0,
            dataPoints: 0,
            metrics: [],
            savingsBasis: 'heuristic',
            savingsBasisDetail: 'Estimativa média por tipo de recurso',
            confidence: 'low',
          },
        },
      ]);

      expect(recommendation?.monthlySavings).toBeGreaterThan(30);
    });

    it('cleans up a stopped VM instead of advising a downsize', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        {
          resource: { ...pricedResource, type: 'Microsoft.Compute/virtualMachines', name: 'vm-parada' },
          reason: 'VM desligada (deallocated), mas os discos continuam sendo cobrados',
          idleScore: 90,
          estimatedMonthlySavings: 349.86,
          metrics: [],
        },
      ]);

      // Downsizing a machine that is already off saves nothing.
      expect(recommendation?.actionType).toBe('CLEANUP');
    });
  });
});
