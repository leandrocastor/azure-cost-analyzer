import type { IdleResource } from '@/models';
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
  describe('billing rationale', () => {
    const buildIdle = (type: string, name: string, reason = 'Baixa utilização'): IdleResource => ({
      resource: {
        id: `/subscriptions/sub/resourceGroups/rg/providers/${type}/${name}`,
        name,
        type,
        resourceGroup: 'rg',
        location: 'brazilsouth',
        sku: 'Standard',
        tags: {},
        status: 'Succeeded',
      },
      reason,
      idleScore: 80,
      estimatedMonthlySavings: 100,
      metrics: [],
    });

    it('never suggests scheduling an App Service shutdown, which does not reduce the bill', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        buildIdle('Microsoft.Web/sites', 'app-a'),
      ]);

      expect(recommendation?.actionType).not.toBe('SCHEDULE');
      expect(recommendation?.actionType).toBe('DOWNSIZE');
      expect(recommendation?.billingRationale?.notApplicable).toContain('não gera economia');
      expect(recommendation?.billingRationale?.billingModel).toContain('App Service Plan');
    });

    it('backs every recommendation with official documentation', async () => {
      const recommendations = await new OptimizerService().generateRecommendations([
        buildIdle('Microsoft.Compute/virtualMachines', 'vm-a'),
        buildIdle('Microsoft.Compute/disks', 'disk-a'),
        buildIdle('Microsoft.Web/sites', 'app-a'),
        buildIdle('Microsoft.Sql/servers/databases', 'db-a'),
        buildIdle('Microsoft.Storage/storageAccounts', 'st-a'),
        buildIdle('Microsoft.Network/publicIPAddresses', 'ip-a'),
      ]);

      expect(recommendations).toHaveLength(6);
      for (const recommendation of recommendations) {
        expect(recommendation.billingRationale?.documentationUrl).toMatch(/^https:\/\/learn\.microsoft\.com\//);
        expect(recommendation.billingRationale?.whySaves.length).toBeGreaterThan(0);
      }
    });

    it('explains that a stopped VM still bills for its disks', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        buildIdle('Microsoft.Compute/virtualMachines', 'vm-parada', 'VM desligada (deallocated), mas os discos continuam sendo cobrados'),
      ]);

      expect(recommendation?.actionType).toBe('CLEANUP');
      expect(recommendation?.billingRationale?.billingModel).toContain('desalocada');
    });

    it('recommends deleting an App Service Plan with zero apps instead of downsizing it', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        buildIdle(
          'Microsoft.Web/serverfarms',
          'plan-vazio',
          'App Service Plan sem nenhum aplicativo implantado, mas continua reservando instâncias e sendo cobrado integralmente',
        ),
      ]);

      expect(recommendation?.actionType).toBe('DELETE');
      expect(recommendation?.billingRationale?.billingModel).toContain('reserva');
    });

    it('recommends downsizing an App Service Plan whose hosted apps are all idle', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        buildIdle(
          'Microsoft.Web/serverfarms',
          'plan-subutilizado',
          'Plano com 2 aplicativo(s) hospedado(s) e CPU média abaixo de 10% nos últimos 7 dias',
        ),
      ]);

      expect(recommendation?.actionType).toBe('DOWNSIZE');
      expect(recommendation?.billingRationale?.documentationUrl).toMatch(/^https:\/\/learn\.microsoft\.com\//);
    });
  });
  describe('savings fidelity against the invoice', () => {
    const withBasis = (
      basis: 'retail-price' | 'observed-cost' | 'heuristic',
      savings: number,
    ): IdleResource => ({
      resource: {
        id: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/app-a',
        name: 'app-a',
        type: 'Microsoft.Web/sites',
        resourceGroup: 'rg',
        location: 'brazilsouth',
        sku: 'Standard',
        tags: {},
        status: 'Succeeded',
      },
      reason: 'Baixa utilização',
      idleScore: 70,
      estimatedMonthlySavings: savings,
      metrics: [],
      evidence: {
        observationWindowDays: 7,
        dataPoints: 168,
        metrics: [],
        savingsBasis: basis,
        savingsBasisDetail: 'detalhe',
        confidence: 'high',
      },
    });

    it('never resurrects savings for a resource whose billing already stopped', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        withBasis('observed-cost', 0),
      ]);

      expect(recommendation?.monthlySavings).toBe(0);
      expect(recommendation?.annualSavings).toBe(0);
    });

    it('publishes the reconciled cost verbatim instead of re-inflating it', async () => {
      const [recommendation] = await new OptimizerService().generateRecommendations([
        withBasis('observed-cost', 88.4),
      ]);

      expect(recommendation?.monthlySavings).toBe(88.4);
    });
  });
});
