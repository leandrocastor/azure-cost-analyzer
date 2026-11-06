import { buildSpendWorklist } from '@/services/spend-worklist';
import { mockCostSummary, mockIdleResources } from '../fixtures/mock-data';

describe('spend worklist', () => {
  it('prioritizes observed service costs without inventing savings or requiring idle findings', () => {
    const result = buildSpendWorklist({ ...mockCostSummary, byService: { Storage: 123.45, 'Foundry Models': 5, Free: 0 } });
    expect(result.services[0]).toMatchObject({ service: 'Storage', cost: 123.45 });
    expect(result.services[0]?.nextStep).toContain('snapshots');
    expect(result.services[1]?.nextStep).toContain('qualidade');
    expect(result.services[2]?.cost).toBe(0);
    expect(result.resourceDetailAvailable).toBe(false);
  });

  it('retains billed-only resources, credits and real zero values, without joining currencies', () => {
    const id = mockIdleResources[0]!.resource.id;
    const result = buildSpendWorklist(mockCostSummary, [{
      currency: mockCostSummary.currency,
      months: ['2026-01', '2026-02'],
      resources: { [id.toUpperCase()]: { '2026-01': 100, '2026-02': -5 }, '/unknown': { '2026-02': 0 } },
    }, { currency: 'EUR', months: ['2026-01'], resources: { '/foreign': { '2026-01': 999 } } }], [mockIdleResources[0]!.resource]);
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0]).toMatchObject({ cost: 95, inventoryMatched: true });
    expect(result.resources[1]).toMatchObject({ cost: 0, inventoryMatched: false });
    expect(result.resources[1]?.monthly).not.toHaveProperty('2026-01');
    expect(result.queriedResourceCost).toBe(95);
  });
});
