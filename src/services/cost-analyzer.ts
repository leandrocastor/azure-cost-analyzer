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

type CostGroupBy = 'service' | 'resource-group' | 'location' | 'tags';

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

  public constructor(private readonly azureClient = new AzureClientService()) {}

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

    try {
      const result = await this.azureClient.executeWithRetry(() =>
        client.query.usage(scope, {
          type: 'ActualCost',
          timeframe: 'Custom',
          timePeriod: {
            from: startDate,
            to: endDate,
          },
          dataset: {
            granularity: 'Daily',
            aggregation: {
              totalCost: {
                name: 'PreTaxCost',
                function: 'Sum',
              },
            },
            grouping: [{ type: 'Dimension', name: this.resolveGroupBy(groupBy) }],
          },
        }),
      );

      const summary = this.toSummary(result, startDate, endDate);
      this.cache.set(cacheKey, summary);
      return summary;
    } catch (error: unknown) {
      this.logger.error('Azure cost query failed', { error: error instanceof Error ? error.message : 'unknown' });
      throw new AzureApiError('Failed to query Azure costs', 500, error);
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
      const result = await this.azureClient.executeWithRetry(() =>
        client.query.usage(`/subscriptions/${this.azureClient.getSubscriptionId()}`, {
          type: 'ActualCost',
          timeframe: 'Custom',
          timePeriod: {
            from: start.toISOString().slice(0, 10),
            to: now.toISOString().slice(0, 10),
          },
          dataset: {
            granularity: 'Daily',
            aggregation: {
              totalCost: {
                name: 'PreTaxCost',
                function: 'Sum',
              },
            },
            grouping: [
              { type: 'Dimension', name: 'ServiceName' },
              { type: 'Dimension', name: 'ResourceGroup' },
              { type: 'Dimension', name: 'ResourceLocation' },
            ],
          },
        }),
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
          forecastAmount: Number(currentAmount.toFixed(2)),
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
      addToBucket(summary.byService, entry.service, entry.amount);
      addToBucket(summary.byResourceGroup, entry.resourceGroup, entry.amount);
      addToBucket(summary.byLocation, entry.location, entry.amount);
    }

    return CostSummarySchema.parse({
      ...summary,
      totalAmount: Number(summary.totalAmount.toFixed(2)),
    });
  }

  private toEntries(result: QueryResult): CostEntry[] {
    const columns = (result.columns ?? []).map((column) => column.name ?? '');
    const rows = result.rows ?? [];
    return rows.map((row) => {
      const entry = CostEntrySchema.parse({
        date: this.readColumn(row, columns, ['UsageDate', 'Date'], 1, new Date().toISOString().slice(0, 10)),
        amount: Number(this.readColumn(row, columns, ['PreTaxCost', 'Cost', 'totalCost'], 0, 0)),
        currency: this.readColumn(row, columns, ['Currency', 'BillingCurrency'], 2, 'USD'),
        service: this.readColumn(row, columns, ['ServiceName'], 3, 'Unknown Service'),
        resourceGroup: this.readColumn(row, columns, ['ResourceGroup'], 4, 'unknown-rg'),
        location: this.readColumn(row, columns, ['ResourceLocation'], 5, 'global'),
        tags: {},
      });
      return entry;
    });
  }

  private readColumn(
    row: unknown[],
    columns: string[],
    names: string[],
    fallbackIndex: number,
    fallbackValue: string | number,
  ): string {
    const index = columns.findIndex((name) => names.includes(name));
    const value = row[index >= 0 ? index : fallbackIndex];
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    return String(fallbackValue);
  }
}
