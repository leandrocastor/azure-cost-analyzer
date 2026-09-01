import { CostManagementClient } from '@azure/arm-costmanagement';

import type {
  CostAnomaly,
  CostAnomalyRootCause,
  CostEntry,
  CostForecast,
  CostSummary,
  CostTrend,
} from '@/models';
import { CostAnomalySchema, CostEntrySchema, CostForecastSchema, CostSummarySchema, CostTrendSchema } from '@/models';
import { AzureClientService } from '@/services/azure-client';
import { Cache } from '@/utils/cache';
import { AzureApiError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { QpuLimiter, costManagementQpuLimiter } from '@/utils/qpu-limiter';
import { getRetryAfterMs, getStatusCode, isThrottlingError } from '@/utils/retry';

type CostGroupBy = 'service' | 'resource-group' | 'location' | 'tags';

/**
 * Actual billed cost per resource, broken down by calendar month. Resource IDs are
 * stored lowercased so lookups are immune to the casing differences between the
 * billing and the management APIs.
 */
export type ResourceCostLedger = {
  currency: string;
  /** Every month covered by the query, sorted ascending, as YYYY-MM. */
  months: string[];
  resources: Record<string, Record<string, number>>;
};

/**
 * Marks a dimension that was not part of the query grouping, so it can be dropped
 * from the summary instead of being reported as a real cost bucket.
 */
const UNAVAILABLE_DIMENSION = '__unavailable__';

/**
 * Azure returns an empty dimension for charges that legitimately belong to no
 * resource group or location, such as subscription-level fees. They are real costs
 * and must stay visible in the report under an explicit bucket.
 */
const UNASSIGNED_DIMENSION = 'sem atribuição';

/**
 * Explains a cost query failure in terms the operator can act on. Being throttled
 * and lacking permission produce the same "no costs" outcome but require opposite
 * responses, so they must never be reported with the same generic message.
 */
const describeCostQueryFailure = (error: unknown): string => {
  const statusCode = getStatusCode(error);

  if (isThrottlingError(error)) {
    return 'Limite de consultas do Cost Management atingido (HTTP 429). A cota é por tenant e considera 1 unidade por mês de dados consultado; reduza --period ou aguarde alguns minutos antes de rodar novamente.';
  }

  if (statusCode === 403 || statusCode === 401) {
    return 'Sem permissão para consultar custos nesta assinatura. É necessário o papel Cost Management Reader (ou Reader) no escopo da assinatura.';
  }

  if (statusCode === 404) {
    return 'Escopo não encontrado ou sem dados de custo. Assinaturas de benefício, como MSDN e Visual Studio, podem não expor custos pela API de Cost Management.';
  }

  const detail = error instanceof Error ? error.message : 'erro desconhecido';
  return `Falha ao consultar os custos no Azure: ${detail}`;
};

type QueryColumn = {
  name?: string;
};

type QueryResult = {
  columns?: QueryColumn[];
  rows?: unknown[][];
};

type CostQueryClient = {
  query: {
    usage: (scope: string, parameters: Record<string, unknown>) => Promise<QueryResult>;
  };
};

const addToBucket = (bucket: Record<string, number>, key: string, value: number): void => {
  bucket[key] = (bucket[key] ?? 0) + value;
};

const formatMonth = (date: Date): string => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Queries Azure Cost Management and converts raw data into analyzable cost models.
 */
export class CostAnalyzerService {
  private readonly logger = createLogger({ service: 'cost-analyzer' });
  private readonly cache = new Cache<unknown>(15 * 60 * 1000);

  public constructor(
    private readonly azureClient = new AzureClientService(),
    private readonly qpuLimiter: QpuLimiter = costManagementQpuLimiter,
  ) {}

  /**
   * Queries summarized cost data for a period and grouping dimension.
   */
  public async queryCosts(
    subscriptionId: string,
    startDate: string,
    endDate: string,
    groupBy: CostGroupBy,
  ): Promise<CostSummary> {
    const cacheKey = `${subscriptionId}:${startDate}:${endDate}:${groupBy}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return CostSummarySchema.parse(cached);
    }

    const scope = `/subscriptions/${subscriptionId}`;
    const client = new CostManagementClient(
      this.azureClient.getCredential(),
    ) as unknown as CostQueryClient;

    // Cost Management charges one QPU per month of data and enforces the budget per
    // tenant, so pace the call before spending it rather than being throttled.
    const qpuCost = QpuLimiter.estimateCost(startDate, endDate);

    try {
      await this.qpuLimiter.acquire(qpuCost);
      const result = await this.azureClient.executeWithRetry(
        async () => {
          try {
            return await client.query.usage(scope, {
              type: 'ActualCost',
              timeframe: 'Custom',
              timePeriod: {
                from: new Date(startDate),
                to: new Date(endDate),
              },
              dataset: {
                // The summary only needs totals per dimension; daily granularity would
                // multiply the payload without adding anything the report uses.
                granularity: 'None',
                aggregation: {
                  totalCost: {
                    name: 'PreTaxCost',
                    function: 'Sum',
                  },
                },
                // The API accepts at most two groupings per query.
                grouping: this.resolveGrouping(groupBy),
              },
            });
          } catch (error: unknown) {
            if (isThrottlingError(error)) {
              this.qpuLimiter.penalize(getRetryAfterMs(error) ?? 20_000);
            }
            throw error;
          }
        },
        // Throttling cool-downs are enforced per tenant and can span a full minute,
        // so cost queries need a longer budget than a generic Azure call.
        { maxAttempts: 8, maxDelayMs: 180_000 },
      );

      const summary = this.toSummary(result, startDate, endDate);
      this.cache.set(cacheKey, summary);
      return summary;
    } catch (error: unknown) {
      this.logger.error('Azure cost query failed', { error: error instanceof Error ? error.message : 'unknown' });
      throw new AzureApiError(describeCostQueryFailure(error), getStatusCode(error) ?? 500, error);
    }
  }

  /**
   * Returns what each resource actually cost, month by month, for the analyzed period.
   *
   * The idle detectors reason about utilization and list prices, which is a projection.
   * This is the invoice. Without it the report claims savings on resources that are
   * billed at zero, such as an App Service on the F1 Free tier, and a single wrong
   * number of that kind is enough for an executive audience to discard the whole report.
   */
  public async queryResourceCosts(
    subscriptionId: string,
    startDate: string,
    endDate: string,
  ): Promise<ResourceCostLedger> {
    const cacheKey = `${subscriptionId}:${startDate}:${endDate}:resource-monthly`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached as ResourceCostLedger;
    }

    const scope = `/subscriptions/${subscriptionId}`;
    const client = new CostManagementClient(
      this.azureClient.getCredential(),
    ) as unknown as CostQueryClient;

    const qpuCost = QpuLimiter.estimateCost(startDate, endDate);

    try {
      await this.qpuLimiter.acquire(qpuCost);
      const result = await this.azureClient.executeWithRetry(
        async () => {
          try {
            return await client.query.usage(scope, {
              type: 'ActualCost',
              timeframe: 'Custom',
              timePeriod: {
                from: new Date(startDate),
                to: new Date(endDate),
              },
              dataset: {
                // Monthly granularity is what makes "it used to cost and no longer
                // does" visible. Daily would multiply the payload for no extra insight.
                granularity: 'Monthly',
                aggregation: {
                  totalCost: {
                    name: 'PreTaxCost',
                    function: 'Sum',
                  },
                },
                grouping: [{ type: 'Dimension', name: 'ResourceId' }],
              },
            });
          } catch (error: unknown) {
            if (isThrottlingError(error)) {
              this.qpuLimiter.penalize(getRetryAfterMs(error) ?? 20_000);
            }
            throw error;
          }
        },
        { maxAttempts: 8, maxDelayMs: 180_000 },
      );

      const ledger = this.toResourceLedger(result);
      this.cache.set(cacheKey, ledger);
      return ledger;
    } catch (error: unknown) {
      this.logger.error('Azure per-resource cost query failed', {
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw new AzureApiError(describeCostQueryFailure(error), getStatusCode(error) ?? 500, error);
    }
  }

  /**
   * Folds the grouped rows into a per-resource, per-month ledger. Resource IDs are
   * lowercased because Azure is inconsistent about their casing between the billing
   * and the management APIs, and a casing mismatch would look like a missing charge.
   */
  private toResourceLedger(result: QueryResult): ResourceCostLedger {
    const columns = (result.columns ?? []).map((column) => column.name ?? '');
    const rows = result.rows ?? [];
    const resources: Record<string, Record<string, number>> = {};
    const months = new Set<string>();
    let currency = 'USD';

    for (const row of rows) {
      const resourceId = this.readColumn(row, columns, ['ResourceId']);
      if (!resourceId) {
        // Subscription-level charges carry no resource ID and cannot be reconciled
        // against a specific finding.
        continue;
      }

      const month = this.readMonth(row, columns);
      if (!month) {
        continue;
      }

      const amount = Number(this.readColumn(row, columns, ['PreTaxCost', 'Cost', 'totalCost']) ?? 0);
      if (!Number.isFinite(amount)) {
        continue;
      }

      currency = this.readColumn(row, columns, ['Currency', 'BillingCurrency']) ?? currency;
      months.add(month);

      const bucket = (resources[resourceId.toLowerCase()] ??= {});
      bucket[month] = (bucket[month] ?? 0) + amount;
    }

    return {
      currency,
      months: [...months].sort(),
      resources,
    };
  }

  /**
   * Normalizes the period column to YYYY-MM. Cost Management returns it either as an
   * ISO timestamp or as the numeric form YYYYMMDD depending on the granularity.
   */
  private readMonth(row: unknown[], columns: string[]): string | undefined {
    const raw = this.readColumn(row, columns, ['UsageDate', 'BillingMonth', 'Date']);
    if (!raw) {
      return undefined;
    }

    if (/^\d{8}$/.test(raw)) {
      return `${raw.slice(0, 4)}-${raw.slice(4, 6)}`;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : formatMonth(parsed);
  }

  /**
   * Returns normalized daily cost entries for the requested trailing month window.
   * Accepts an explicit subscription id override so tenant-wide runs can query
   * each subscription in turn, the same way queryCosts/queryResourceCosts do.
   */
  public async getCostsByPeriod(months: number, subscriptionId?: string): Promise<CostEntry[]> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(0, months - 1), 1));
    const client = new CostManagementClient(
      this.azureClient.getCredential(),
    ) as unknown as CostQueryClient;

    try {
      const qpuCost = QpuLimiter.estimateCost(start, now);
      await this.qpuLimiter.acquire(qpuCost);
      const result = await this.azureClient.executeWithRetry(
        async () => {
          try {
            return await client.query.usage(`/subscriptions/${this.azureClient.getSubscriptionId(subscriptionId)}`, {
              type: 'ActualCost',
              timeframe: 'Custom',
              timePeriod: {
                from: start,
                to: now,
              },
              dataset: {
                // Monthly buckets are enough for trend analysis and keep the payload small.
                granularity: 'Monthly',
                aggregation: {
                  totalCost: {
                    name: 'PreTaxCost',
                    function: 'Sum',
                  },
                },
                // The API accepts at most two groupings per query.
                grouping: [
                  { type: 'Dimension', name: 'ServiceName' },
                  { type: 'Dimension', name: 'ResourceGroup' },
                ],
              },
            });
          } catch (error: unknown) {
            if (isThrottlingError(error)) {
              this.qpuLimiter.penalize(getRetryAfterMs(error) ?? 20_000);
            }
            throw error;
          }
        },
        { maxAttempts: 8, maxDelayMs: 180_000 },
      );

      return this.toEntries(result);
    } catch (error: unknown) {
      throw new AzureApiError('Failed to fetch cost history', 500, error);
    }
  }

  /**
   * Calculates month-over-month cost trends.
   */
  public async analyzeTrends(months: number): Promise<CostTrend[]> {
    const entries = await this.getCostsByPeriod(months);
    const byMonth = new Map<string, number>();

    for (const entry of entries) {
      const key = entry.date.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) ?? 0) + entry.amount);
    }

    const ordered = Array.from(byMonth.entries()).sort(([a], [b]) => a.localeCompare(b));
    return ordered.map(([period, amount], index) => {
      const previousAmount = ordered[index - 1]?.[1] ?? amount;
      const percentChange = previousAmount === 0 ? 0 : ((amount - previousAmount) / previousAmount) * 100;
      return CostTrendSchema.parse({ period, amount, percentChange });
    });
  }

  /**
   * Detects anomalous cost spikes using a z-score threshold above 2, aggregating
   * entries to real per-month totals first (the raw entries are broken down by
   * service and resource group, so summing every row for a month is what yields
   * the actual monthly total).
   */
  public detectAnomalies(entries: CostEntry[]): CostAnomaly[] {
    const monthlyTotals = this.sumByKey(entries, (entry) => entry.date);
    const months = [...monthlyTotals.keys()].sort();
    if (months.length < 2) {
      return [];
    }

    const amounts = months.map((month) => monthlyTotals.get(month) ?? 0);
    const average = amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length;
    const variance = amounts.reduce((sum, amount) => sum + (amount - average) ** 2, 0) / amounts.length;
    const standardDeviation = Math.sqrt(variance);

    if (standardDeviation === 0) {
      return [];
    }

    // Root causes are attributed only from the breakdown already present in
    // the same entries used to detect the spike: no extra Azure call, and
    // nothing beyond what the billing data itself shows.
    const byServicePerMonth = this.sumByMonthAndKey(entries, (entry) => entry.service);
    const byResourceGroupPerMonth = this.sumByMonthAndKey(entries, (entry) => entry.resourceGroup);

    return months
      .map((month) => {
        const amount = monthlyTotals.get(month) ?? 0;
        const deviation = (amount - average) / standardDeviation;
        if (deviation <= 2) {
          return null;
        }

        const rootCauses = [
          ...this.buildRootCauses('service', month, byServicePerMonth, amount - average),
          ...this.buildRootCauses('resourceGroup', month, byResourceGroupPerMonth, amount - average),
        ];

        return {
          date: month,
          amount,
          expectedAmount: average,
          deviation,
          severity: deviation > 3 ? 'high' : deviation > 2.5 ? 'medium' : 'low',
          rootCauses,
        } satisfies CostAnomaly;
      })
      .filter((item): item is CostAnomaly => item !== null)
      .map((item) => CostAnomalySchema.parse(item));
  }

  /**
   * Sums entry amounts grouped by an arbitrary key extractor.
   */
  private sumByKey(entries: CostEntry[], keyOf: (entry: CostEntry) => string): Map<string, number> {
    const totals = new Map<string, number>();
    for (const entry of entries) {
      const key = keyOf(entry);
      totals.set(key, (totals.get(key) ?? 0) + entry.amount);
    }
    return totals;
  }

  /**
   * Sums entry amounts grouped by month and then by an arbitrary dimension key,
   * used to attribute an anomalous month's spike to the service or resource
   * group that drove it.
   */
  private sumByMonthAndKey(
    entries: CostEntry[],
    keyOf: (entry: CostEntry) => string,
  ): Map<string, Map<string, number>> {
    const byMonth = new Map<string, Map<string, number>>();
    for (const entry of entries) {
      const key = keyOf(entry);
      const bucket = byMonth.get(entry.date) ?? new Map<string, number>();
      bucket.set(key, (bucket.get(key) ?? 0) + entry.amount);
      byMonth.set(entry.date, bucket);
    }
    return byMonth;
  }

  /**
   * Finds which keys of a dimension (service or resource group) contributed the
   * most to the delta between an anomalous month and the average, ranked by
   * absolute contribution and capped to the top 2 so the report stays readable.
   */
  private buildRootCauses(
    dimension: 'service' | 'resourceGroup',
    anomalyMonth: string,
    byMonthAndKey: Map<string, Map<string, number>>,
    totalDelta: number,
  ): CostAnomalyRootCause[] {
    const monthsWithData = [...byMonthAndKey.entries()];
    const anomalyBucket = byMonthAndKey.get(anomalyMonth);
    if (!anomalyBucket || monthsWithData.length < 2 || totalDelta === 0) {
      return [];
    }

    const otherMonths = monthsWithData.filter(([month]) => month !== anomalyMonth);
    const keys = new Set(monthsWithData.flatMap(([, bucket]) => [...bucket.keys()]));

    const contributions = [...keys]
      .map((key) => {
        const amountOnAnomalyDate = anomalyBucket.get(key) ?? 0;
        const averageAmount =
          otherMonths.length > 0
            ? otherMonths.reduce((sum, [, bucket]) => sum + (bucket.get(key) ?? 0), 0) / otherMonths.length
            : 0;
        const deltaAmount = amountOnAnomalyDate - averageAmount;
        return { key, amountOnAnomalyDate, averageAmount, deltaAmount };
      })
      .filter((item) => item.deltaAmount > 0)
      .sort((left, right) => right.deltaAmount - left.deltaAmount)
      .slice(0, 2);

    return contributions.map((item) => ({
      dimension,
      key: item.key,
      amountOnAnomalyDate: Number(item.amountOnAnomalyDate.toFixed(2)),
      averageAmount: Number(item.averageAmount.toFixed(2)),
      deltaAmount: Number(item.deltaAmount.toFixed(2)),
      shareOfTotalDelta: Number(Math.min(1, Math.max(0, item.deltaAmount / totalDelta)).toFixed(4)),
    }));
  }

  /**
   * Forecasts monthly costs using trailing average growth.
   */
  public async forecastCosts(months: 3 | 6 | 12): Promise<CostForecast[]> {
    const trends = await this.analyzeTrends(Math.max(months, 6));
    if (trends.length === 0) {
      return [];
    }

    const growthRates = trends.slice(1).map((trend) => trend.percentChange / 100);
    const avgGrowth = growthRates.length > 0
      ? growthRates.reduce((sum, rate) => sum + rate, 0) / growthRates.length
      : 0;
    const last = trends[trends.length - 1];
    if (!last) {
      return [];
    }
    const forecasts: CostForecast[] = [];
    let currentAmount = last.amount;

    for (let index = 1; index <= months; index += 1) {
      currentAmount = Math.max(0, currentAmount * (1 + avgGrowth));
      const futureDate = new Date(Date.UTC(
        Number.parseInt(last.period.slice(0, 4), 10),
        Number.parseInt(last.period.slice(5, 7), 10) - 1 + index,
        1,
      ));
      forecasts.push(
        CostForecastSchema.parse({
          period: formatMonth(futureDate),
          // A projection below zero is not meaningful for planning, so it is floored.
          forecastAmount: Number(Math.max(0, currentAmount).toFixed(2)),
          confidence: Number(Math.max(0.5, 1 - Math.abs(avgGrowth)).toFixed(2)),
          trend: avgGrowth > 0.02 ? 'up' : avgGrowth < -0.02 ? 'down' : 'flat',
        }),
      );
    }

    return forecasts;
  }

  private resolveGroupBy(groupBy: CostGroupBy): string {
    const mapping: Record<CostGroupBy, string> = {
      service: 'ServiceName',
      'resource-group': 'ResourceGroup',
      location: 'ResourceLocation',
      tags: 'TagKey',
    };
    return mapping[groupBy];
  }

  /**
   * Builds the grouping clause. The API accepts at most two groupings, so the
   * requested dimension is paired with a complementary one to fill more of the
   * report from a single request instead of spending extra QPU on another call.
   */
  private resolveGrouping(groupBy: CostGroupBy): { type: string; name: string }[] {
    const primary = this.resolveGroupBy(groupBy);
    const companion: Partial<Record<CostGroupBy, string>> = {
      service: 'ResourceGroup',
      'resource-group': 'ServiceName',
      location: 'ServiceName',
    };

    const secondary = companion[groupBy];
    const dimensions = secondary ? [primary, secondary] : [primary];
    return dimensions.map((name) => ({ type: 'Dimension', name }));
  }

  private toSummary(result: QueryResult, startDate: string, endDate: string): CostSummary {
    const entries = this.toEntries(result);
    const summary: CostSummary = {
      period: `${startDate}..${endDate}`,
      totalAmount: 0,
      currency: entries[0]?.currency ?? 'USD',
      byService: {},
      byResourceGroup: {},
      byLocation: {},
    };

    for (const entry of entries) {
      summary.totalAmount += entry.amount;
      // A dimension that was not part of the grouping carries no real value, so it
      // is omitted instead of being charted as a bogus catch-all bucket.
      addToBucket(summary.byService, entry.service, entry.amount);
      addToBucket(summary.byResourceGroup, entry.resourceGroup, entry.amount);
      addToBucket(summary.byLocation, entry.location, entry.amount);
    }

    delete summary.byService[UNAVAILABLE_DIMENSION];
    delete summary.byResourceGroup[UNAVAILABLE_DIMENSION];
    delete summary.byLocation[UNAVAILABLE_DIMENSION];

    return CostSummarySchema.parse({
      ...summary,
      totalAmount: Number(summary.totalAmount.toFixed(2)),
    });
  }

  private toEntries(result: QueryResult): CostEntry[] {
    const columns = (result.columns ?? []).map((column) => column.name ?? '');
    const rows = result.rows ?? [];
    const entries: CostEntry[] = [];
    let skipped = 0;

    for (const row of rows) {
      const parsed = CostEntrySchema.safeParse({
        date:
          this.readColumn(row, columns, ['UsageDate', 'Date']) ??
          new Date().toISOString().slice(0, 10),
        amount: Number(this.readColumn(row, columns, ['PreTaxCost', 'Cost', 'totalCost']) ?? 0),
        currency: this.readColumn(row, columns, ['Currency', 'BillingCurrency']) ?? 'USD',
        service: this.readDimension(row, columns, ['ServiceName']),
        resourceGroup: this.readDimension(row, columns, ['ResourceGroup']),
        location: this.readDimension(row, columns, ['ResourceLocation']),
        tags: {},
      });

      // A single unexpected row must not discard the whole subscription's costs.
      if (parsed.success) {
        entries.push(parsed.data);
      } else {
        skipped += 1;
      }
    }

    if (skipped > 0) {
      this.logger.warn('Ignoring cost rows that could not be parsed', { skipped, total: rows.length });
    }

    return entries;
  }

  /**
   * Reads a grouped dimension, separating two cases that must not be confused:
   * a dimension that was never requested (and therefore carries no information)
   * from one that Azure legitimately returns blank, such as charges billed at the
   * subscription level that belong to no resource group.
   */
  private readDimension(row: unknown[], columns: string[], names: string[]): string {
    if (!columns.some((column) => names.includes(column))) {
      return UNAVAILABLE_DIMENSION;
    }

    return this.readColumn(row, columns, names) ?? UNASSIGNED_DIMENSION;
  }

  /**
   * Reads a column strictly by name. Positional fallbacks are unsafe here: the
   * Cost Management response only contains the columns that were requested, and
   * their order varies, so guessing by index silently mixes up dimensions.
   * Blank values are reported as missing so callers can apply their own default.
   */
  private readColumn(row: unknown[], columns: string[], names: string[]): string | undefined {
    const index = columns.findIndex((column) => names.includes(column));
    if (index < 0) {
      return undefined;
    }

    const value = row[index];
    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }

    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
}
