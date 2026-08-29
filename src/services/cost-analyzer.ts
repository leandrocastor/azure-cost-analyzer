import { CostManagementClient } from '@azure/arm-costmanagement';

import type {
  CostAnomaly,
  CostEntry,
  CostForecast,
  CostSummary,
  CostTrend,
} from '@/models';
import { CostEntrySchema, CostForecastSchema, CostSummarySchema, CostTrendSchema } from '@/models';
import { AzureClientService } from '@/services/azure-client';
import { Cache } from '@/utils/cache';
import { AzureApiError } from '@/utils/errors';
import { createLogger } from '@/utils/logger';
import { QpuLimiter, costManagementQpuLimiter } from '@/utils/qpu-limiter';
import { getRetryAfterMs, getStatusCode, isThrottlingError } from '@/utils/retry';

type CostGroupBy = 'service' | 'resource-group' | 'location' | 'tags';

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
      const result = await this.azureClient.executeWithRetry(
        async () => {
          await this.qpuLimiter.acquire(qpuCost);
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
        { maxAttempts: 8, maxDelayMs: 120_000 },
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
   * Returns normalized daily cost entries for the requested trailing month window.
   */
  public async getCostsByPeriod(months: number): Promise<CostEntry[]> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.max(0, months - 1), 1));
    const client = new CostManagementClient(
      this.azureClient.getCredential(),
    ) as unknown as CostQueryClient;

    try {
      const qpuCost = QpuLimiter.estimateCost(start, now);
      const result = await this.azureClient.executeWithRetry(
        async () => {
          await this.qpuLimiter.acquire(qpuCost);
          try {
            return await client.query.usage(`/subscriptions/${this.azureClient.getSubscriptionId()}`, {
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
        { maxAttempts: 8, maxDelayMs: 120_000 },
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
   * Detects anomalous cost spikes using a z-score threshold above 2.
   */
  public detectAnomalies(entries: CostEntry[]): CostAnomaly[] {
    if (entries.length < 2) {
      return [];
    }

    const average = entries.reduce((sum, entry) => sum + entry.amount, 0) / entries.length;
    const variance = entries.reduce((sum, entry) => sum + (entry.amount - average) ** 2, 0) / entries.length;
    const standardDeviation = Math.sqrt(variance);

    if (standardDeviation === 0) {
      return [];
    }

    return entries
      .map((entry) => {
        const deviation = (entry.amount - average) / standardDeviation;
        if (deviation <= 2) {
          return null;
        }

        return {
          date: entry.date,
          amount: entry.amount,
          expectedAmount: average,
          deviation,
          severity: deviation > 3 ? 'high' : deviation > 2.5 ? 'medium' : 'low',
        } satisfies CostAnomaly;
      })
      .filter((item): item is CostAnomaly => item !== null);
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
