import type { IdleResource, OwnerWaste, OwnershipReport } from '@/models';
import { OwnershipReportSchema } from '@/models';

/**
 * Tag keys inspected to attribute waste to an owner, in priority order.
 * Matching is case-insensitive, so `Owner`, `owner` and `OWNER` all work.
 */
export const DEFAULT_OWNER_TAG_KEYS = [
  'owner',
  'Owner',
  'ownedby',
  'ownedBy',
  'team',
  'Team',
  'squad',
  'costcenter',
  'costCenter',
  'CostCenter',
  'centrodecusto',
  'department',
  'businessunit',
];

const UNASSIGNED_OWNER = 'Sem responsável definido';
const TOP_RESOURCES_PER_OWNER = 5;

type Attribution = {
  owner: string;
  attribution: OwnerWaste['attribution'];
  attributionKey: string;
};

/**
 * Attributes idle-resource waste to owners so the report can be used for
 * showback/chargeback. This is the gap native Azure Cost Management leaves
 * open: it shows *where* money is burning, not *who* is responsible for it.
 */
export class OwnershipService {
  private readonly tagKeys: string[];

  public constructor(tagKeys: string[] = DEFAULT_OWNER_TAG_KEYS) {
    this.tagKeys = tagKeys;
  }

  /**
   * Builds the ownership breakdown, ranked by monthly waste.
   */
  public buildReport(idleResources: IdleResource[]): OwnershipReport {
    const buckets = new Map<string, { attribution: Attribution; resources: IdleResource[] }>();
    let taggedResourceCount = 0;

    for (const idle of idleResources) {
      const attribution = this.attribute(idle);
      if (attribution.attribution === 'tag') {
        taggedResourceCount += 1;
      }

      const bucket = buckets.get(attribution.owner);
      if (bucket) {
        bucket.resources.push(idle);
      } else {
        buckets.set(attribution.owner, { attribution, resources: [idle] });
      }
    }

    const totalMonthlyWaste = idleResources.reduce((sum, idle) => sum + idle.estimatedMonthlySavings, 0);

    const owners: OwnerWaste[] = [...buckets.values()]
      .map(({ attribution, resources }) => {
        const monthlyWaste = resources.reduce((sum, idle) => sum + idle.estimatedMonthlySavings, 0);
        return {
          owner: attribution.owner,
          attribution: attribution.attribution,
          attributionKey: attribution.attributionKey,
          resourceCount: resources.length,
          monthlyWaste: Number(monthlyWaste.toFixed(2)),
          annualWaste: Number((monthlyWaste * 12).toFixed(2)),
          shareOfTotal: totalMonthlyWaste > 0 ? Number((monthlyWaste / totalMonthlyWaste).toFixed(4)) : 0,
          topResources: [...resources]
            .sort((left, right) => right.estimatedMonthlySavings - left.estimatedMonthlySavings)
            .slice(0, TOP_RESOURCES_PER_OWNER)
            .map((idle) => ({
              name: idle.resource.name,
              type: idle.resource.type,
              resourceGroup: idle.resource.resourceGroup,
              monthlySavings: idle.estimatedMonthlySavings,
            })),
        };
      })
      .sort((left, right) => right.monthlyWaste - left.monthlyWaste);

    const untaggedResourceCount = idleResources.length - taggedResourceCount;

    return OwnershipReportSchema.parse({
      owners,
      totalMonthlyWaste: Number(totalMonthlyWaste.toFixed(2)),
      totalAnnualWaste: Number((totalMonthlyWaste * 12).toFixed(2)),
      taggedResourceCount,
      untaggedResourceCount,
      tagCoverage: idleResources.length > 0 ? Number((taggedResourceCount / idleResources.length).toFixed(4)) : 0,
      inspectedTagKeys: this.tagKeys,
    });
  }

  /**
   * Resolves the owner of a single resource: an ownership tag when present,
   * otherwise the resource group (a common de-facto ownership boundary).
   */
  private attribute(idle: IdleResource): Attribution {
    const tags = idle.resource.tags ?? {};
    const normalized = new Map(
      Object.entries(tags).map(([key, value]) => [key.trim().toLowerCase(), { key, value }]),
    );

    for (const candidate of this.tagKeys) {
      const match = normalized.get(candidate.trim().toLowerCase());
      if (match?.value.trim()) {
        return { owner: match.value.trim(), attribution: 'tag', attributionKey: match.key };
      }
    }

    const resourceGroup = idle.resource.resourceGroup?.trim();
    if (resourceGroup && resourceGroup !== 'N/A') {
      return {
        owner: `${resourceGroup} (resource group)`,
        attribution: 'resource-group',
        attributionKey: 'resourceGroup',
      };
    }

    return { owner: UNASSIGNED_OWNER, attribution: 'unassigned', attributionKey: '' };
  }
}
