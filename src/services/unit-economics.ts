import type { Resource, UnitEconomicsEntry, UnitEconomicsReport } from '@/models';
import { UnitEconomicsReportSchema } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';

/**
 * Tag keys tried, in priority order, to answer "cost per what" — the first
 * key with at least one tagged resource is used. Nothing is invented when
 * none of these tags exist: the section is simply omitted from the report.
 */
export const DEFAULT_UNIT_ECONOMICS_TAG_KEYS = [
  'app',
  'App',
  'application',
  'Application',
  'aplicacao',
  'Aplicacao',
  'customer',
  'Customer',
  'cliente',
  'Cliente',
  'project',
  'Project',
  'projeto',
  'Projeto',
];

const MAX_ENTRIES = 15;

const latestBilledAmount = (resourceId: string, ledger: ResourceCostLedger): number => {
  const months = ledger.resources[resourceId.toLowerCase()];
  if (!months) {
    return 0;
  }
  const latestMonth = ledger.months.at(-1);
  return latestMonth ? (months[latestMonth] ?? 0) : 0;
};

const findTagValue = (resource: Resource, tagKeys: string[]): string | undefined => {
  const tags = resource.tags ?? {};
  const normalized = new Map(Object.entries(tags).map(([key, value]) => [key.trim().toLowerCase(), value]));
  for (const candidate of tagKeys) {
    const value = normalized.get(candidate.trim().toLowerCase())?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
};

/**
 * Groups real billed cost (never a list-price projection) by a single
 * "cost per what" tag — the answer to "how much is this app/customer/project
 * actually costing", which neither Cost Management nor Advisor break down on
 * their own. Returns undefined when none of the candidate tags are used
 * anywhere in the estate, rather than forcing a misleading empty section.
 */
export class UnitEconomicsService {
  private readonly candidateTagKeys: string[];

  public constructor(candidateTagKeys: string[] = DEFAULT_UNIT_ECONOMICS_TAG_KEYS) {
    this.candidateTagKeys = candidateTagKeys;
  }

  public build(resources: Resource[], ledger: ResourceCostLedger): UnitEconomicsReport | undefined {
    const groupTagKey = this.resolveGroupTagKey(resources);
    if (!groupTagKey) {
      return undefined;
    }

    const byKey = new Map<string, { monthlyCost: number; resourceCount: number }>();
    let untaggedMonthlyCost = 0;
    let untaggedResourceCount = 0;

    for (const resource of resources) {
      const monthlyCost = latestBilledAmount(resource.id, ledger);
      const tagValue = findTagValue(resource, [groupTagKey]);

      if (!tagValue) {
        untaggedMonthlyCost += monthlyCost;
        untaggedResourceCount += 1;
        continue;
      }

      const bucket = byKey.get(tagValue) ?? { monthlyCost: 0, resourceCount: 0 };
      bucket.monthlyCost += monthlyCost;
      bucket.resourceCount += 1;
      byKey.set(tagValue, bucket);
    }

    const taggedMonthlyCost = Number([...byKey.values()].reduce((sum, item) => sum + item.monthlyCost, 0).toFixed(2));

    const entries: UnitEconomicsEntry[] = [...byKey.entries()]
      .map(([key, item]) => ({
        key,
        monthlyCost: Number(item.monthlyCost.toFixed(2)),
        resourceCount: item.resourceCount,
        shareOfTaggedTotal: taggedMonthlyCost > 0 ? Number((item.monthlyCost / taggedMonthlyCost).toFixed(4)) : 0,
      }))
      .sort((left, right) => right.monthlyCost - left.monthlyCost)
      .slice(0, MAX_ENTRIES);

    const summary =
      entries.length === 0
        ? `Nenhum recurso com a tag "${groupTagKey}" preenchida gera custo faturado no período.`
        : `Custo faturado agrupado pela tag "${groupTagKey}": ${entries.length} valor(es) distintos, liderado por "${entries[0]?.key}" com ${entries[0]?.monthlyCost.toFixed(2)} ${ledger.currency}/mês.`;

    return UnitEconomicsReportSchema.parse({
      groupTagKey,
      entries,
      taggedMonthlyCost,
      untaggedMonthlyCost: Number(untaggedMonthlyCost.toFixed(2)),
      untaggedResourceCount,
      summary,
    });
  }

  /**
   * Picks the first candidate tag key that is actually used by at least one
   * resource, so the grouping key shown in the report always reflects a real
   * convention already in use in the tenant.
   */
  private resolveGroupTagKey(resources: Resource[]): string | undefined {
    for (const candidate of this.candidateTagKeys) {
      const used = resources.some((resource) => findTagValue(resource, [candidate]) !== undefined);
      if (used) {
        return candidate;
      }
    }
    return undefined;
  }
}
