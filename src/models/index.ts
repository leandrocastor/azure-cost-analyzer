import { z } from 'zod';

const tagsSchema = z.record(z.string(), z.string()).default({});
const nonNegativeNumber = z.number().finite().min(0);

export const CostEntrySchema = z.object({
  date: z.string().min(1),
  amount: nonNegativeNumber,
  currency: z.string().min(1),
  service: z.string().min(1),
  resourceGroup: z.string().min(1),
  location: z.string().min(1),
  tags: tagsSchema,
});

export const CostSummarySchema = z.object({
  period: z.string().min(1),
  totalAmount: nonNegativeNumber,
  currency: z.string().min(1),
  byService: z.record(z.string(), nonNegativeNumber),
  byResourceGroup: z.record(z.string(), nonNegativeNumber),
  byLocation: z.record(z.string(), nonNegativeNumber),
});

export const CostTrendSchema = z.object({
  period: z.string().min(1),
  amount: nonNegativeNumber,
  percentChange: z.number().finite(),
});

export const CostAnomalySchema = z.object({
  date: z.string().min(1),
  amount: nonNegativeNumber,
  expectedAmount: nonNegativeNumber,
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

export const IdleResourceSchema = z.object({
  resource: ResourceSchema,
  reason: z.string().min(1),
  idleScore: z.number().min(0).max(100),
  estimatedMonthlySavings: nonNegativeNumber,
  metrics: z.array(ResourceMetricSchema),
});

export const ActionTypeSchema = z.enum([
  'DELETE',
  'DOWNSIZE',
  'CHANGE_SKU',
  'SCHEDULE',
  'MIGRATE',
  'CLEANUP',
]);

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

export type CostEntry = z.infer<typeof CostEntrySchema>;
export type CostSummary = z.infer<typeof CostSummarySchema>;
export type CostTrend = z.infer<typeof CostTrendSchema>;
export type CostAnomaly = z.infer<typeof CostAnomalySchema>;
export type CostForecast = z.infer<typeof CostForecastSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type ResourceMetric = z.infer<typeof ResourceMetricSchema>;
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
