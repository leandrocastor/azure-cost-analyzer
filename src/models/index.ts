import { z } from 'zod';

const tagsSchema = z.record(z.string(), z.string()).default({});
const nonNegativeNumber = z.number().finite().min(0);
// Aggregated cost buckets can end up negative when credits or refunds outweigh the
// charges in the period, so totals must not be constrained to non-negative values.
const costAmount = z.number().finite();

export const CostEntrySchema = z.object({
  date: z.string().min(1),
  // Azure reports credits and refunds as negative charges; discarding them would
  // overstate the total, so the entry level accepts any finite amount.
  amount: z.number().finite(),
  currency: z.string().min(1),
  service: z.string().min(1),
  resourceGroup: z.string().min(1),
  location: z.string().min(1),
  tags: tagsSchema,
});

export const CostSummarySchema = z.object({
  period: z.string().min(1),
  totalAmount: costAmount,
  currency: z.string().min(1),
  byService: z.record(z.string(), costAmount),
  byResourceGroup: z.record(z.string(), costAmount),
  byLocation: z.record(z.string(), costAmount),
});

export const CostTrendSchema = z.object({
  period: z.string().min(1),
  amount: costAmount,
  percentChange: z.number().finite(),
});

export const CostAnomalySchema = z.object({
  date: z.string().min(1),
  amount: costAmount,
  expectedAmount: costAmount,
  deviation: z.number().finite(),
  severity: z.enum(['low', 'medium', 'high']),
});

export const CostForecastSchema = z.object({
  period: z.string().min(1),
  forecastAmount: nonNegativeNumber,
  confidence: z.number().min(0).max(1),
  trend: z.enum(['up', 'down', 'flat']),
});

export const ResourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  resourceGroup: z.string().min(1),
  location: z.string().min(1),
  sku: z.string().min(1),
  tags: tagsSchema,
  status: z.string().min(1),
});

export const ResourceMetricSchema = z.object({
  resourceId: z.string().min(1),
  metricName: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  timestamp: z.string().min(1),
});

/**
 * How a savings figure was obtained. Presenting this alongside the amount is what
 * separates an auditable estimate from a guess: "retail-price" means the real Azure
 * list price for that SKU and region, while "heuristic" is a conservative fallback
 * used when the price could not be resolved.
 */
export const SavingsBasisSchema = z.enum(['retail-price', 'observed-cost', 'heuristic']);

/**
 * Confidence in a finding, derived from how much evidence backs it.
 */
export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

/**
 * A single observation supporting a finding, expressed so a reader can verify it:
 * the measured value, the threshold it was compared against, and the comparison.
 */
export const EvidenceMetricSchema = z.object({
  label: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  threshold: z.number().finite().optional(),
  comparison: z.enum(['below', 'above', 'equals']).optional(),
});

/**
 * The audit trail behind a finding. Without it, "this VM is idle" is an opinion the
 * application team can dismiss; with it, the claim carries the measurements, the
 * observation window and the basis of the savings figure.
 */
/**
 * What the resource actually cost according to Cost Management, month by month.
 *
 * A savings estimate derived from list prices is a projection; this is the invoice.
 * Without it the report can claim savings on a resource that is billed at zero, such
 * as an App Service on the F1 Free tier, which destroys its credibility with finance.
 */
export const BilledCostSchema = z.object({
  /** Total actually billed for the resource across the analyzed period. */
  observedTotal: costAmount,
  currency: z.string().min(1),
  /** Cost per calendar month, keyed as YYYY-MM. */
  monthly: z.record(z.string(), costAmount),
  /** Most recent month, as YYYY-MM, in which the resource was billed above zero. */
  lastMonthWithCost: z.string().optional(),
  /** Latest complete month covered by the cost query, as YYYY-MM. */
  latestMonth: z.string().min(1),
  /** True when the resource was billed earlier in the period but no longer is. */
  billingStopped: z.boolean(),
});

export const EvidenceSchema = z.object({
  observationWindowDays: z.number().int().min(0),
  dataPoints: z.number().int().min(0),
  metrics: z.array(EvidenceMetricSchema).default([]),
  savingsBasis: SavingsBasisSchema,
  savingsBasisDetail: z.string().min(1),
  confidence: ConfidenceSchema,
  /** Why the confidence is not high, when applicable. */
  caveat: z.string().optional(),
  /** Reconciliation against the actual invoice, when cost data could be retrieved. */
  billed: BilledCostSchema.optional(),
});

export const IdleResourceSchema = z.object({
  resource: ResourceSchema,
  reason: z.string().min(1),
  idleScore: z.number().min(0).max(100),
  estimatedMonthlySavings: nonNegativeNumber,
  metrics: z.array(ResourceMetricSchema),
  evidence: EvidenceSchema.optional(),
});

export const ActionTypeSchema = z.enum([
  'DELETE',
  'DOWNSIZE',
  'CHANGE_SKU',
  'SCHEDULE',
  'MIGRATE',
  'CLEANUP',
]);

/**
 * The documented reason an action reduces cost for a given service.
 *
 * Azure billing models differ in ways that invalidate otherwise sensible advice: a
 * stopped VM stops compute charges, whereas a stopped App Service keeps billing
 * because its plan continues to reserve the VM instances. Every action must be able
 * to point at the documentation that backs it.
 */
export const BillingRationaleSchema = z.object({
  /** How the service is billed, in one sentence. */
  billingModel: z.string().min(1),
  /** Why the recommended action changes that bill. */
  whySaves: z.string().min(1),
  /** Official Microsoft Learn URL supporting the statement. */
  documentationUrl: z.string().url(),
  /** Actions explicitly ruled out for this service, and why. */
  notApplicable: z.string().optional(),
});

export const RecommendationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  resourceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  monthlySavings: nonNegativeNumber,
  annualSavings: nonNegativeNumber,
  risk: z.enum(['low', 'medium', 'high']),
  effort: z.enum(['low', 'medium', 'high']),
  roi: z.number().finite(),
  actionType: ActionTypeSchema,
  status: z.enum(['new', 'planned', 'in-progress', 'completed', 'dismissed']),
  evidence: EvidenceSchema.optional(),
  /**
   * Why this action actually reduces the bill for this service, plus the official
   * documentation that states it. A suggestion that sounds reasonable but does not
   * hold for the service billing model, such as scheduling an App Service shutdown,
   * costs more credibility than the money it claims to save.
   */
  billingRationale: BillingRationaleSchema.optional(),
});

/**
 * A single executable step of a remediation plan (pre-check, apply or rollback).
 */
export const RemediationStepSchema = z.object({
  description: z.string().min(1),
  command: z.string().min(1),
});

/**
 * A ready-to-run remediation plan attached to a recommendation. It turns
 * "you should downsize this VM" into the exact commands and IaC snippets an
 * operator can execute, validate and roll back.
 */
export const RemediationPlanSchema = z.object({
  recommendationId: z.string().min(1),
  resourceId: z.string().min(1),
  resourceName: z.string().min(1),
  resourceGroup: z.string().min(1),
  subscriptionId: z.string().min(1),
  actionType: ActionTypeSchema,
  risk: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1),
  monthlySavings: nonNegativeNumber,
  requiresDowntime: z.boolean(),
  preChecks: z.array(RemediationStepSchema),
  apply: z.array(RemediationStepSchema),
  rollback: z.array(RemediationStepSchema),
  iac: z.object({
    terraform: z.string(),
    bicep: z.string(),
  }),
});

/**
 * Aggregated waste attributed to a single owner (team, cost center or person).
 */
export const OwnerWasteSchema = z.object({
  owner: z.string().min(1),
  attribution: z.enum(['tag', 'resource-group', 'unassigned']),
  attributionKey: z.string(),
  resourceCount: z.number().int().min(0),
  monthlyWaste: nonNegativeNumber,
  annualWaste: nonNegativeNumber,
  shareOfTotal: z.number().min(0).max(1),
  topResources: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().min(1),
      resourceGroup: z.string().min(1),
      monthlySavings: nonNegativeNumber,
    }),
  ),
});

/**
 * Showback/chargeback view: waste broken down by owner plus coverage metrics
 * that reveal how much of the estate is missing ownership tags.
 */
export const OwnershipReportSchema = z.object({
  owners: z.array(OwnerWasteSchema),
  totalMonthlyWaste: nonNegativeNumber,
  totalAnnualWaste: nonNegativeNumber,
  taggedResourceCount: z.number().int().min(0),
  untaggedResourceCount: z.number().int().min(0),
  tagCoverage: z.number().min(0).max(1),
  inspectedTagKeys: z.array(z.string()),
});

/**
 * Difference of a single bucket (service, resource group, ...) between two runs.
 */
export const CostDeltaSchema = z.object({
  key: z.string().min(1),
  previous: z.number().finite(),
  current: z.number().finite(),
  delta: z.number().finite(),
  percentChange: z.number().finite().nullable(),
});

/**
 * Comparison between the current run and a previously generated report.
 */
export const CostDiffSchema = z.object({
  previousGeneratedAt: z.string().min(1),
  previousPeriod: z.string().min(1),
  currentPeriod: z.string().min(1),
  totalPrevious: z.number().finite(),
  totalCurrent: z.number().finite(),
  totalDelta: z.number().finite(),
  totalPercentChange: z.number().finite().nullable(),
  currency: z.string().min(1),
  byService: z.array(CostDeltaSchema),
  byResourceGroup: z.array(CostDeltaSchema),
  idleCountPrevious: z.number().int().min(0),
  idleCountCurrent: z.number().int().min(0),
  newIdleResources: z.array(z.string()),
  resolvedIdleResources: z.array(z.string()),
});

/**
 * Executive-level narrative rendered at the top of the report.
 */
export const ExecutiveSummarySchema = z.object({
  headline: z.string().min(1),
  paragraphs: z.array(z.string().min(1)),
  highlights: z.array(
    z.object({
      label: z.string().min(1),
      value: z.string().min(1),
      tone: z.enum(['positive', 'negative', 'neutral']),
    }),
  ),
  topActions: z.array(z.string()),
  generatedBy: z.enum(['heuristic', 'azure-openai']),
});

/**
 * A single automated assessment of the Well-Architected Framework's Cost
 * Optimization pillar. The WAF review is normally a manual questionnaire answered
 * from memory; answering it from collected evidence turns a subjective exercise
 * into an auditable artifact.
 */
export const WafCheckSchema = z.object({
  id: z.string().min(1),
  /** WAF recommendation code, e.g. CO:05. */
  code: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pass', 'fail', 'partial', 'not-applicable']),
  /** What was observed in the tenant to reach this verdict. */
  evidence: z.string().min(1),
  impact: z.enum(['low', 'medium', 'high']),
  recommendation: z.string().min(1),
  /** Points earned out of the check's weight. */
  score: z.number().min(0),
  weight: z.number().min(0),
});

export const WafScorecardSchema = z.object({
  /** Overall score from 0 to 100 for the Cost Optimization pillar. */
  score: z.number().min(0).max(100),
  grade: z.enum(['A', 'B', 'C', 'D', 'E']),
  summary: z.string().min(1),
  checks: z.array(WafCheckSchema),
  evaluatedAt: z.string().min(1),
});

/**
 * A recommendation that was already reported previously and remains open. Tracking
 * it converts advice into accumulated debt, which is a far stronger argument than
 * repeating the same suggestion every month.
 */
export const StaleRecommendationSchema = z.object({
  resourceId: z.string().min(1),
  resourceName: z.string().min(1),
  title: z.string().min(1),
  monthlySavings: nonNegativeNumber,
  firstSeenAt: z.string().min(1),
  daysOpen: z.number().int().min(0),
  /** Money already lost since the finding was first reported. */
  wastedSoFar: nonNegativeNumber,
});

export const InactionCostSchema = z.object({
  comparedTo: z.string().min(1),
  daysBetween: z.number().int().min(0),
  stale: z.array(StaleRecommendationSchema),
  resolved: z.number().int().min(0),
  totalWasted: nonNegativeNumber,
  projectedAnnualWaste: nonNegativeNumber,
  summary: z.string().min(1),
});

/**
 * How ready a recommendation is to be executed, so an operator can triage a long
 * list of findings instead of treating every one as equally actionable.
 *
 * - `EXECUTAVEL_AGORA`: strong evidence and low risk; safe to run through the
 *   generated remediation plan without further validation.
 * - `VALIDAR_ANTES`: the saving is real or likely, but risk, effort or partial
 *   confidence warrant a manual check before acting.
 * - `SOMENTE_HISTORICO`: the cost this finding once represented has already
 *   stopped; kept visible for the record, but there is nothing left to execute.
 * - `INVESTIGAR`: evidence is too weak (low confidence or a heuristic price) to
 *   act on directly; needs more data before it becomes a recommendation.
 */
export const DecisionCategorySchema = z.enum([
  'EXECUTAVEL_AGORA',
  'VALIDAR_ANTES',
  'SOMENTE_HISTORICO',
  'INVESTIGAR',
]);

/** How trustworthy the savings figure itself is, independent of execution readiness. */
export const SavingsStatusSchema = z.enum(['confirmada', 'provavel', 'nao-confirmada']);

export const DecisionSchema = z.object({
  recommendationId: z.string().min(1),
  resourceId: z.string().min(1),
  resourceName: z.string().min(1),
  category: DecisionCategorySchema,
  savingsStatus: SavingsStatusSchema,
  monthlySavings: nonNegativeNumber,
  reasoning: z.string().min(1),
});

export const DecisionEngineReportSchema = z.object({
  decisions: z.array(DecisionSchema),
  confirmedMonthlySavings: nonNegativeNumber,
  probableMonthlySavings: nonNegativeNumber,
  unconfirmedMonthlySavings: nonNegativeNumber,
  executableNowCount: z.number().int().min(0),
  summary: z.string().min(1),
});

/**
 * A resource confirmed old (via Azure Resource Graph creation time, never
 * estimated) that still generates real billed cost and carries no ownership
 * tag. This is the governance blind spot native Azure tooling leaves open:
 * Cost Management and Advisor show spend and idleness, not "who forgot this
 * exists and who do I ask before touching it".
 */
export const AgingResourceSchema = z.object({
  resourceId: z.string().min(1),
  resourceName: z.string().min(1),
  resourceType: z.string().min(1),
  resourceGroup: z.string().min(1),
  createdAt: z.string().min(1),
  ageDays: z.number().int().min(0),
  monthlyCost: nonNegativeNumber,
  currency: z.string().min(1),
  isIdle: z.boolean(),
});

export const AgingReportSchema = z.object({
  resources: z.array(AgingResourceSchema),
  totalMonthlyCostAtRisk: nonNegativeNumber,
  oldestResourceAgeDays: z.number().int().min(0),
  resourcesInspected: z.number().int().min(0),
  resourcesWithConfirmedAge: z.number().int().min(0),
  summary: z.string().min(1),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;
export type CostSummary = z.infer<typeof CostSummarySchema>;
export type CostTrend = z.infer<typeof CostTrendSchema>;
export type CostAnomaly = z.infer<typeof CostAnomalySchema>;
export type CostForecast = z.infer<typeof CostForecastSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type ResourceMetric = z.infer<typeof ResourceMetricSchema>;
export type SavingsBasis = z.infer<typeof SavingsBasisSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type EvidenceMetric = z.infer<typeof EvidenceMetricSchema>;
export type BilledCost = z.infer<typeof BilledCostSchema>;
export type BillingRationale = z.infer<typeof BillingRationaleSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type IdleResource = z.infer<typeof IdleResourceSchema>;
export type Recommendation = z.infer<typeof RecommendationSchema>;
export type ActionType = z.infer<typeof ActionTypeSchema>;
export type RemediationStep = z.infer<typeof RemediationStepSchema>;
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;
export type OwnerWaste = z.infer<typeof OwnerWasteSchema>;
export type OwnershipReport = z.infer<typeof OwnershipReportSchema>;
export type CostDelta = z.infer<typeof CostDeltaSchema>;
export type CostDiff = z.infer<typeof CostDiffSchema>;
export type ExecutiveSummary = z.infer<typeof ExecutiveSummarySchema>;
export type WafCheck = z.infer<typeof WafCheckSchema>;
export type WafScorecard = z.infer<typeof WafScorecardSchema>;
export type StaleRecommendation = z.infer<typeof StaleRecommendationSchema>;
export type InactionCost = z.infer<typeof InactionCostSchema>;
export type DecisionCategory = z.infer<typeof DecisionCategorySchema>;
export type SavingsStatus = z.infer<typeof SavingsStatusSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionEngineReport = z.infer<typeof DecisionEngineReportSchema>;
export type AgingResource = z.infer<typeof AgingResourceSchema>;
export type AgingReport = z.infer<typeof AgingReportSchema>;
