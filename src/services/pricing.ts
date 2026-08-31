/**
 * Resolves real Azure list prices from the public Retail Prices API.
 *
 * Savings estimates used to be hardcoded constants, which made every virtual
 * machine "worth" the same amount regardless of its SKU or region. The Retail
 * Prices API is public (no authentication, no quota tied to the tenant) and
 * returns the actual list price per SKU per region, so estimates become
 * defensible numbers instead of guesses.
 *
 * Prices are list prices: they ignore Enterprise Agreement discounts, reservations
 * and negotiated rates, so callers must present them as an upper-bound estimate.
 *
 * @see https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices
 */

import { Cache } from '@/utils/cache';
import { createLogger } from '@/utils/logger';

const RETAIL_PRICES_ENDPOINT = 'https://prices.azure.com/api/retail/prices';

/** Billing hours in a month, the convention Azure itself uses for monthly estimates. */
export const HOURS_PER_MONTH = 730;

/** Caps pagination so a badly scoped query cannot stall the report. */
const MAX_PRICE_PAGES = 5;

/** Spot and low-priority meters are far cheaper and would understate the savings. */
const EXCLUDED_METER_PATTERN = /spot|low priority/i;

export type RetailPriceItem = {
  retailPrice: number;
  unitPrice: number;
  currencyCode: string;
  unitOfMeasure: string;
  meterName: string;
  productName: string;
  skuName: string;
  armSkuName: string;
  armRegionName: string;
  serviceName: string;
  type: string;
};

export type PriceQuery = {
  serviceName: string;
  region: string;
  armSkuName?: string;
  /**
   * Exact meter name, applied server-side. Required for catalogs such as Storage
   * that expose hundreds of meters per region, where a client-side filter would
   * only ever see the first page of results.
   */
  meterName?: string;
  /** Narrows the result when a service exposes many meters for the same SKU. */
  meterNamePattern?: RegExp;
  /**
   * Narrows by product name, needed for catalogs where the OS (Windows/Linux) is
   * only distinguishable in the product name, not in the meter name.
   */
  productNamePattern?: RegExp;
};

export type MonthlyPrice = {
  amount: number;
  currency: string;
  meterName: string;
  unitOfMeasure: string;
  region: string;
};

type RetailPricesResponse = {
  Items?: RetailPriceItem[];
  BillingCurrency?: string;
  NextPageLink?: string;
};

export type PricingServiceOptions = {
  currency?: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds before a lookup is abandoned so pricing never blocks a report. */
  timeoutMs?: number;
};

/**
 * Converts a unit price into a monthly amount based on the meter's unit of measure.
 * Returns undefined for units that cannot be projected without usage data, such as
 * per-GB or per-10K-operations meters.
 */
export const toMonthlyAmount = (unitPrice: number, unitOfMeasure: string): number | undefined => {
  const normalized = unitOfMeasure.trim().toLowerCase();

  if (normalized.includes('hour')) {
    // Meters can be quoted in blocks, e.g. "100 Hours".
    const quantity = Number.parseFloat(normalized) || 1;
    return (unitPrice / quantity) * HOURS_PER_MONTH;
  }

  if (normalized.includes('month')) {
    const quantity = Number.parseFloat(normalized) || 1;
    return unitPrice / quantity;
  }

  if (normalized.includes('day')) {
    const quantity = Number.parseFloat(normalized) || 1;
    return (unitPrice / quantity) * 30;
  }

  return undefined;
};

/**
 * Looks up Azure list prices, caching results because a single report queries the
 * same SKU and region repeatedly.
 */
export class PricingService {
  private readonly logger = createLogger({ service: 'pricing' });
  private readonly cache = new Cache<MonthlyPrice | null>(6 * 60 * 60 * 1000);
  private readonly currency: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private unavailable = false;

  public constructor(options: PricingServiceOptions = {}) {
    this.currency = options.currency ?? 'USD';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * Returns the monthly list price for a SKU, or undefined when it cannot be
   * resolved. Pricing is an enrichment: a failure must never fail the report.
   */
  public async getMonthlyPrice(query: PriceQuery): Promise<MonthlyPrice | undefined> {
    // One outage is enough to stop retrying for the rest of the run.
    if (this.unavailable) {
      return undefined;
    }

    const cacheKey = `${query.serviceName}|${query.region}|${query.armSkuName ?? ''}|${query.meterName ?? ''}|${query.meterNamePattern?.source ?? ''}|${query.productNamePattern?.source ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    try {
      const items = await this.fetchPrices(query);
      const price = this.selectCheapestMonthlyPrice(items, query);
      this.cache.set(cacheKey, price ?? null);
      return price;
    } catch (error: unknown) {
      this.logger.warn('Retail price lookup failed', {
        serviceName: query.serviceName,
        region: query.region,
        error: error instanceof Error ? error.message : 'unknown',
      });
      this.unavailable = true;
      return undefined;
    }
  }

  /** True once a lookup failed, so callers can explain why estimates fell back. */
  public get isUnavailable(): boolean {
    return this.unavailable;
  }

  private async fetchPrices(query: PriceQuery): Promise<RetailPriceItem[]> {
    const filters = [
      `serviceName eq '${escapeODataLiteral(query.serviceName)}'`,
      `armRegionName eq '${escapeODataLiteral(query.region)}'`,
      `priceType eq 'Consumption'`,
    ];

    if (query.armSkuName) {
      filters.push(`armSkuName eq '${escapeODataLiteral(query.armSkuName)}'`);
    }

    if (query.meterName) {
      filters.push(`meterName eq '${escapeODataLiteral(query.meterName)}'`);
    }

    const url = new URL(RETAIL_PRICES_ENDPOINT);
    url.searchParams.set('currencyCode', this.currency);
    url.searchParams.set('$filter', filters.join(' and '));

    return this.fetchAllPages(url.toString());
  }

  /**
   * The API pages at 100 items, so a broad catalog would silently hide the meter we
   * are looking for. Paging is capped because a query that needs more than a few
   * pages is too broad to yield a meaningful price anyway.
   */
  private async fetchAllPages(firstUrl: string): Promise<RetailPriceItem[]> {
    const items: RetailPriceItem[] = [];
    let next: string | undefined = firstUrl;
    let page = 0;

    while (next && page < MAX_PRICE_PAGES) {
      const payload = await this.fetchPage(next);
      items.push(...(payload.Items ?? []));
      next = payload.NextPageLink;
      page += 1;
    }

    return items;
  }

  private async fetchPage(url: string): Promise<RetailPricesResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as RetailPricesResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Picks the cheapest eligible meter. A SKU in a region exposes several meters
   * (Windows and Linux, different tiers); the cheapest keeps the savings estimate
   * conservative, which is the safer error to make when advising a customer.
   */
  private selectCheapestMonthlyPrice(items: RetailPriceItem[], query: PriceQuery): MonthlyPrice | undefined {
    let best: MonthlyPrice | undefined;

    for (const item of items) {
      if (EXCLUDED_METER_PATTERN.test(item.meterName)) {
        continue;
      }

      if (query.meterNamePattern && !query.meterNamePattern.test(item.meterName)) {
        continue;
      }

      if (query.productNamePattern && !query.productNamePattern.test(item.productName)) {
        continue;
      }

      const unitPrice = item.retailPrice ?? item.unitPrice;
      if (typeof unitPrice !== 'number' || unitPrice <= 0) {
        continue;
      }

      const amount = toMonthlyAmount(unitPrice, item.unitOfMeasure ?? '');
      if (amount === undefined || amount <= 0) {
        continue;
      }

      if (!best || amount < best.amount) {
        best = {
          amount: Number(amount.toFixed(2)),
          currency: item.currencyCode ?? this.currency,
          meterName: item.meterName ?? 'unknown',
          unitOfMeasure: item.unitOfMeasure ?? 'unknown',
          region: item.armRegionName ?? query.region,
        };
      }
    }

    return best;
  }
}

/** OData string literals escape single quotes by doubling them. */
const escapeODataLiteral = (value: string): string => value.replace(/'/g, "''");
