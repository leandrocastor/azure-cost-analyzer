import { describe, expect, it } from 'vitest';

import { OwnershipService } from '@/services/ownership';
import type { IdleResource } from '@/models';
import { mockIdleResources, mockResource } from '../fixtures/mock-data';

const withTags = (tags: Record<string, string>, savings: number, name: string): IdleResource => ({
  ...mockIdleResources[0]!,
  resource: { ...mockResource, id: `/subscriptions/s/resourceGroups/rg-a/providers/p/t/${name}`, name, tags },
  estimatedMonthlySavings: savings,
});

describe('OwnershipService', () => {
  it('attributes waste to the owner tag and ranks owners by monthly waste', () => {
    const report = new OwnershipService().buildReport([
      withTags({ owner: 'squad-pagamentos' }, 100, 'vm-1'),
      withTags({ Owner: 'squad-checkout' }, 300, 'vm-2'),
      withTags({ owner: 'squad-pagamentos' }, 50, 'vm-3'),
    ]);

    expect(report.owners[0]?.owner).toBe('squad-checkout');
    expect(report.owners[0]?.monthlyWaste).toBe(300);
    expect(report.owners[1]?.owner).toBe('squad-pagamentos');
    expect(report.owners[1]?.resourceCount).toBe(2);
    expect(report.owners[1]?.monthlyWaste).toBe(150);
    expect(report.totalMonthlyWaste).toBe(450);
    expect(report.totalAnnualWaste).toBe(5400);
  });

  it('matches owner tags case-insensitively and records the original tag key', () => {
    const report = new OwnershipService().buildReport([withTags({ COSTCENTER: 'CC-42' }, 10, 'vm-1')]);

    expect(report.owners[0]?.owner).toBe('CC-42');
    expect(report.owners[0]?.attribution).toBe('tag');
    expect(report.owners[0]?.attributionKey).toBe('COSTCENTER');
  });

  it('falls back to the resource group when no ownership tag is present', () => {
    const report = new OwnershipService().buildReport([withTags({ environment: 'dev' }, 25, 'vm-1')]);

    expect(report.owners[0]?.attribution).toBe('resource-group');
    expect(report.owners[0]?.owner).toBe('rg-a (resource group)');
    expect(report.tagCoverage).toBe(0);
  });

  it('reports tag coverage across tagged and untagged resources', () => {
    const report = new OwnershipService().buildReport([
      withTags({ owner: 'time-a' }, 10, 'vm-1'),
      withTags({}, 10, 'vm-2'),
      withTags({ team: 'time-b' }, 10, 'vm-3'),
      withTags({}, 10, 'vm-4'),
    ]);

    expect(report.taggedResourceCount).toBe(2);
    expect(report.untaggedResourceCount).toBe(2);
    expect(report.tagCoverage).toBe(0.5);
  });

  it('honours custom tag keys', () => {
    const report = new OwnershipService(['responsavel']).buildReport([
      withTags({ responsavel: 'infra', owner: 'ignorado' }, 10, 'vm-1'),
    ]);

    expect(report.owners[0]?.owner).toBe('infra');
  });

  it('keeps only the top five resources per owner, ordered by savings', () => {
    const resources = Array.from({ length: 7 }, (_, index) =>
      withTags({ owner: 'time-a' }, (index + 1) * 10, `vm-${index}`),
    );

    const report = new OwnershipService().buildReport(resources);

    expect(report.owners[0]?.topResources).toHaveLength(5);
    expect(report.owners[0]?.topResources[0]?.monthlySavings).toBe(70);
  });

  it('returns an empty report without dividing by zero when there is no waste', () => {
    const report = new OwnershipService().buildReport([]);

    expect(report.owners).toEqual([]);
    expect(report.tagCoverage).toBe(0);
    expect(report.totalMonthlyWaste).toBe(0);
  });
});
