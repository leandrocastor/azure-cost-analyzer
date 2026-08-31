import type { ForgottenEnvironmentReport, ForgottenEnvironmentResource, IdleResource, Resource } from '@/models';
import { ForgottenEnvironmentReportSchema } from '@/models';
import type { ResourceCostLedger } from '@/services/cost-analyzer';

/** A non-production resource this old and still billing is a governance risk. */
export const FORGOTTEN_ENV_THRESHOLD_DAYS = 90;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Tag keys inspected for an explicit environment classification. */
export const DEFAULT_ENVIRONMENT_TAG_KEYS = ['environment', 'Environment', 'env', 'Env', 'ambiente', 'Ambiente', 'stage', 'Stage'];

/**
 * Non-production name/tag fragments, matched case-insensitively as substrings.
 * Deliberately conservative: only well-known non-prod vocabulary, so a resource
 * legitimately named e.g. "demodesk-prod-api" is not the intent here — matching
 * is a signal to *investigate*, backed by real age and real cost, not a verdict
 * on its own.
 */
export const DEFAULT_NON_PROD_PATTERNS = [
  'dev',
  'test',
  'teste',
  'hml',
  'homolog',
  'staging',
  'stg',
  'qa',
  'lab',
  'poc',
  'demo',
  'sandbox',
  'temp',
  'tmp',
  'old',
  'legacy',
  'backup',
  'bkp',
];

type Match = { pattern: string; matchedOn: 'name' | 'tag'; tagKey?: string };

/**
 * Finds the most recent billed monthly amount for a resource in the ledger.
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
 * Looks for a non-prod pattern in the resource name or in the value of an
 * environment tag. The resource name is checked first because it is the
 * strongest, least ambiguous signal (nobody names a production VM
 * "vm-test-01" by accident); the tag is a fallback when the name is generic.
 */
const matchNonProdPattern = (
  resource: Resource,
  patterns: string[],
  environmentTagKeys: string[],
): Match | undefined => {
  const nameLower = resource.name.toLowerCase();
  const nameMatch = patterns.find((pattern) => nameLower.includes(pattern));
  if (nameMatch) {
    return { pattern: nameMatch, matchedOn: 'name' };
  }

  const tags = resource.tags ?? {};
  const normalizedTagKeys = new Map(Object.keys(tags).map((key) => [key.trim().toLowerCase(), key]));
  for (const candidate of environmentTagKeys) {
    const originalKey = normalizedTagKeys.get(candidate.trim().toLowerCase());
    if (!originalKey) {
      continue;
    }
    const value = tags[originalKey]?.trim().toLowerCase();
    if (!value) {
      continue;
    }
    const tagMatch = patterns.find((pattern) => value.includes(pattern));
    if (tagMatch) {
      return { pattern: tagMatch, matchedOn: 'tag', tagKey: originalKey };
    }
  }

  return undefined;
};

/**
 * Flags non-production resources (by name or environment tag) that are old
 * enough and still billing real cost to be a "someone forgot to tear this
 * down" candidate — a common source of silent waste that neither Azure
 * Advisor nor Cost Management calls out on their own.
 *
 * Just like the aging/ownerless detector, age is only ever taken from a
 * confirmed Azure Resource Graph creation timestamp: a resource whose age
 * cannot be confirmed is skipped rather than guessed.
 */
export class EnvironmentDetectorService {
  private readonly patterns: string[];
  private readonly environmentTagKeys: string[];

  public constructor(
    patterns: string[] = DEFAULT_NON_PROD_PATTERNS,
    environmentTagKeys: string[] = DEFAULT_ENVIRONMENT_TAG_KEYS,
  ) {
    this.patterns = patterns;
    this.environmentTagKeys = environmentTagKeys;
  }

  public detect(
    resources: Resource[],
    creationTimes: Map<string, string>,
    ledger: ResourceCostLedger,
    idleResources: IdleResource[],
    now: Date = new Date(),
  ): ForgottenEnvironmentReport {
    const idleResourceIds = new Set(idleResources.map((idle) => idle.resource.id.toLowerCase()));
    const findings: ForgottenEnvironmentResource[] = [];
    let resourcesWithConfirmedAge = 0;

    for (const resource of resources) {
      const match = matchNonProdPattern(resource, this.patterns, this.environmentTagKeys);
      if (!match) {
        continue;
      }

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
      if (ageDays < FORGOTTEN_ENV_THRESHOLD_DAYS) {
        continue;
      }

      const monthlyCost = latestBilledAmount(resource.id, ledger);
      if (monthlyCost <= 0) {
        continue;
      }

      findings.push({
        resourceId: resource.id,
        resourceName: resource.name,
        resourceType: resource.type,
        resourceGroup: resource.resourceGroup,
        matchedPattern: match.pattern,
        matchedOn: match.matchedOn,
        matchedTagKey: match.tagKey,
        createdAt,
        ageDays,
        monthlyCost: Number(monthlyCost.toFixed(2)),
        currency: ledger.currency,
        isIdle: idleResourceIds.has(resource.id.toLowerCase()),
      });
    }

    findings.sort((left, right) => right.monthlyCost - left.monthlyCost);

    const totalMonthlyCostAtRisk = Number(findings.reduce((sum, item) => sum + item.monthlyCost, 0).toFixed(2));

    const summary =
      findings.length === 0
        ? 'Nenhum ambiente não produtivo esquecido foi encontrado com custo faturado confirmado.'
        : `${findings.length} recurso(s) com nome ou tag de ambiente não produtivo, mais de ${FORGOTTEN_ENV_THRESHOLD_DAYS} dias e custo faturado confirmado, somando ${totalMonthlyCostAtRisk.toFixed(2)} ${ledger.currency}/mês.`;

    return ForgottenEnvironmentReportSchema.parse({
      resources: findings,
      totalMonthlyCostAtRisk,
      resourcesInspected: resources.length,
      resourcesWithConfirmedAge,
      summary,
    });
  }
}
