import type { GovernanceRankingEntry, GovernanceReport, Resource, TagCoverage } from '@/models';
import { GovernanceReportSchema } from '@/models';
import { DEFAULT_OWNER_TAG_KEYS } from '@/services/ownership';
import { DEFAULT_ENVIRONMENT_TAG_KEYS } from '@/services/environment-detector';

/** Tag keys inspected for a cost center classification. */
export const DEFAULT_COST_CENTER_TAG_KEYS = ['costcenter', 'costCenter', 'CostCenter', 'centrodecusto', 'centroDeCusto'];

const TOP_WORST_RESOURCE_GROUPS = 10;

/**
 * Checks whether any of the candidate tag keys is present (case-insensitively)
 * with a non-empty value on the resource.
 */
const hasTag = (resource: Resource, tagKeys: string[]): boolean => {
  const normalized = new Map(Object.keys(resource.tags ?? {}).map((key) => [key.trim().toLowerCase(), key]));
  return tagKeys.some((candidate) => {
    const match = normalized.get(candidate.trim().toLowerCase());
    return match !== undefined && Boolean(resource.tags?.[match]?.trim());
  });
};

/**
 * Reports how much of the resource estate is missing the tags that make
 * showback, chargeback and incident response possible — owner, environment
 * and cost center — and ranks which resource groups are worst-governed.
 * This is a gap native Azure Cost Management and Advisor leave open: they
 * show cost and configuration risk, never tagging hygiene.
 */
export class GovernanceReportService {
  private readonly ownerTagKeys: string[];
  private readonly environmentTagKeys: string[];
  private readonly costCenterTagKeys: string[];

  public constructor(
    ownerTagKeys: string[] = DEFAULT_OWNER_TAG_KEYS,
    environmentTagKeys: string[] = DEFAULT_ENVIRONMENT_TAG_KEYS,
    costCenterTagKeys: string[] = DEFAULT_COST_CENTER_TAG_KEYS,
  ) {
    this.ownerTagKeys = ownerTagKeys;
    this.environmentTagKeys = environmentTagKeys;
    this.costCenterTagKeys = costCenterTagKeys;
  }

  public buildReport(resources: Resource[]): GovernanceReport {
    if (resources.length === 0) {
      return GovernanceReportSchema.parse({
        resourcesInspected: 0,
        coverage: [],
        worstResourceGroups: [],
        summary: 'Nenhum recurso disponível para avaliar a governança de tags.',
      });
    }

    const coverage: TagCoverage[] = [
      this.buildCoverage(resources, 'owner', 'Responsável (owner)', this.ownerTagKeys),
      this.buildCoverage(resources, 'environment', 'Ambiente (environment)', this.environmentTagKeys),
      this.buildCoverage(resources, 'costCenter', 'Centro de custo (costCenter)', this.costCenterTagKeys),
    ];

    const worstResourceGroups = this.rankResourceGroups(resources);

    const worstMissingPercent = Math.max(...coverage.map((item) => item.missingPercent));
    const worstCoverage = coverage.find((item) => item.missingPercent === worstMissingPercent);

    const summary =
      worstCoverage && worstMissingPercent > 0
        ? `${(worstMissingPercent * 100).toFixed(0)}% dos ${resources.length} recurso(s) inspecionados não têm a tag de ${worstCoverage.label.toLowerCase()}, a lacuna de governança mais crítica encontrada.`
        : `Todos os ${resources.length} recurso(s) inspecionados têm as tags de governança avaliadas.`;

    return GovernanceReportSchema.parse({
      resourcesInspected: resources.length,
      coverage,
      worstResourceGroups,
      summary,
    });
  }

  private buildCoverage(resources: Resource[], tagKey: string, label: string, tagKeys: string[]): TagCoverage {
    const presentCount = resources.filter((resource) => hasTag(resource, tagKeys)).length;
    const missingCount = resources.length - presentCount;

    return {
      tagKey,
      label,
      presentCount,
      missingCount,
      missingPercent: resources.length > 0 ? Number((missingCount / resources.length).toFixed(4)) : 0,
    };
  }

  private rankResourceGroups(resources: Resource[]): GovernanceRankingEntry[] {
    const byGroup = new Map<string, Resource[]>();
    for (const resource of resources) {
      const key = resource.resourceGroup || 'N/A';
      const bucket = byGroup.get(key) ?? [];
      bucket.push(resource);
      byGroup.set(key, bucket);
    }

    return [...byGroup.entries()]
      .map(([resourceGroup, group]) => {
        const missingAnyTagCount = group.filter(
          (resource) =>
            !hasTag(resource, this.ownerTagKeys) ||
            !hasTag(resource, this.environmentTagKeys) ||
            !hasTag(resource, this.costCenterTagKeys),
        ).length;

        return {
          resourceGroup,
          resourceCount: group.length,
          missingAnyTagCount,
          missingAnyTagPercent: Number((missingAnyTagCount / group.length).toFixed(4)),
        };
      })
      .filter((entry) => entry.missingAnyTagCount > 0)
      .sort((left, right) => right.missingAnyTagPercent - left.missingAnyTagPercent || right.resourceCount - left.resourceCount)
      .slice(0, TOP_WORST_RESOURCE_GROUPS);
  }
}
