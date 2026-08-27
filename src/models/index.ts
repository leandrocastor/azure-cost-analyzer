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
