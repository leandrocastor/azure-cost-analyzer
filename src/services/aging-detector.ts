import type { AgingReport, AgingResource, IdleResource, Resource } from '@/models';
import { AgingReportSchema } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';
import { DEFAULT_OWNER_TAG_KEYS } from '@/services/ownership';

/** A resource must be at least this old to count as "aging" for governance purposes. */
export const AGING_THRESHOLD_DAYS = 180;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

const hasOwnerTag = (resource: Resource, tagKeys: string[]): boolean => {
  const normalized = new Map(Object.keys(resource.tags ?? {}).map((key) => [key.trim().toLowerCase(), key]));
  return tagKeys.some((candidate) => {
    const match = normalized.get(candidate.trim().toLowerCase());
    return match !== undefined && Boolean(resource.tags?.[match]?.trim());
  });
};

/**
 * Finds the most recent billed monthly amount for a resource in the ledger,
 * so "aging" is reported against real spend rather than a list-price estimate.
 */
const latestBilledAmount = (resourceId: string, ledger: ResourceCostLedger): number => {
  const months = ledger.resources[resourceId.toLowerCase()];
  if (!months) {
    return 0;
  }
  const latestMonth = ledger.months.at(-1);
  return latestMonth ? (months[latestMonth] ?? 0) : 0;
};

/**
 * Flags resources that are simultaneously old, still costing money, and
 * ownerless — the exact combination that makes cloud environments accumulate
 * "nobody knows what this is for" spend. This is a distinct governance risk
 * from idleness: an aging, ownerless resource can be fully utilized and still
 * be a liability, because nobody can be asked before decommissioning it,
 * renewing a certificate on it, or reacting when it breaks.
 *
 * Every finding requires a creation date **confirmed** by Azure Resource
 * Graph. A resource whose age cannot be confirmed is skipped rather than
 * assumed to be new or old — guessing here is exactly the kind of imprecision
 * that erodes trust in a report meant for an executive audience.
 */
export class AgingDetectorService {
  private readonly tagKeys: string[];

  public constructor(tagKeys: string[] = DEFAULT_OWNER_TAG_KEYS) {
    this.tagKeys = tagKeys;
  }

  public detect(
    resources: Resource[],
    creationTimes: Map<string, string>,
    ledger: ResourceCostLedger,
    idleResources: IdleResource[],
    now: Date = new Date(),
  ): AgingReport {
    const idleResourceIds = new Set(idleResources.map((idle) => idle.resource.id.toLowerCase()));
    const findings: AgingResource[] = [];
    let resourcesWithConfirmedAge = 0;

    for (const resource of resources) {
      const createdAt = creationTimes.get(resource.id.toLowerCase());
      if (!createdAt) {
        continue;
      }

      const createdDate = new Date(createdAt);
      if (Number.isNaN(createdDate.getTime())) {
        continue;
      }

      resourcesWithConfirmedAge += 1;
      const ageDays = Math.floor((now.getTime() - createdDate.getTime()) / MS_PER_DAY);
      if (ageDays < AGING_THRESHOLD_DAYS) {
        continue;
      }

      const monthlyCost = latestBilledAmount(resource.id, ledger);
      if (monthlyCost <= 0) {
        // Not costing anything right now: a governance concern, perhaps, but
        // not a financial one, so it stays out of a cost-focused report.
        continue;
      }

      if (hasOwnerTag(resource, this.tagKeys)) {
        continue;
      }

      findings.push({
        resourceId: resource.id,
        resourceName: resource.name,
        resourceType: resource.type,
        resourceGroup: resource.resourceGroup,
        createdAt,
        ageDays,
        monthlyCost: Number(monthlyCost.toFixed(2)),
        currency: ledger.currency,
        isIdle: idleResourceIds.has(resource.id.toLowerCase()),
      });
    }

    findings.sort((left, right) => right.monthlyCost - left.monthlyCost);

    const totalMonthlyCostAtRisk = Number(findings.reduce((sum, item) => sum + item.monthlyCost, 0).toFixed(2));
    const oldestResourceAgeDays = findings.reduce((max, item) => Math.max(max, item.ageDays), 0);

    const summary =
      findings.length === 0
        ? 'Nenhum recurso envelhecido e sem responsável definido foi encontrado com custo faturado confirmado.'
        : `${findings.length} recurso(s) com mais de ${AGING_THRESHOLD_DAYS} dias, sem tag de responsável e com custo faturado confirmado, somando ${totalMonthlyCostAtRisk.toFixed(2)} ${ledger.currency}/mês em risco de governança.`;

    return AgingReportSchema.parse({
      resources: findings,
      totalMonthlyCostAtRisk,
      oldestResourceAgeDays,
      resourcesInspected: resources.length,
      resourcesWithConfirmedAge,
      summary,
    });
  }
}
