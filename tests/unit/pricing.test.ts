import { PricingService, toMonthlyAmount, HOURS_PER_MONTH } from '@/services/pricing';

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, json: async () => payload }) as unknown as Response;

describe('toMonthlyAmount', () => {
  it('projects hourly meters over a billing month', () => {
    expect(toMonthlyAmount(1, '1 Hour')).toBe(HOURS_PER_MONTH);
  });

  it('divides meters quoted in blocks of hours', () => {
    expect(toMonthlyAmount(100, '100 Hours')).toBe(HOURS_PER_MONTH);
  });

  it('passes monthly meters through', () => {
    expect(toMonthlyAmount(50, '1/Month')).toBe(50);
  });

  it('projects daily meters over thirty days', () => {
    expect(toMonthlyAmount(2, '1 Day')).toBe(60);
  });

  it('rejects units that cannot be projected without usage data', () => {
    expect(toMonthlyAmount(0.05, '1 GB')).toBeUndefined();
    expect(toMonthlyAmount(0.01, '10K')).toBeUndefined();
  });
});

describe('PricingService', () => {
  it('returns the monthly list price for a SKU', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [
          {
            retailPrice: 0.159,
            unitPrice: 0.159,
            currencyCode: 'USD',
            unitOfMeasure: '1 Hour',
            meterName: 'D2s v3',
            armSkuName: 'Standard_D2s_v3',
            armRegionName: 'brazilsouth',
          },
        ],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({
      serviceName: 'Virtual Machines',
      region: 'brazilsouth',
      armSkuName: 'Standard_D2s_v3',
    });

    expect(price?.amount).toBe(116.07);
    expect(price?.meterName).toBe('D2s v3');
  });

  it('ignores spot and low priority meters that would understate the savings', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [
          { retailPrice: 0.005, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3 Spot', armRegionName: 'eastus' },
          { retailPrice: 0.008, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3 Low Priority', armRegionName: 'eastus' },
          { retailPrice: 0.1, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3', armRegionName: 'eastus' },
        ],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({ serviceName: 'Virtual Machines', region: 'eastus' });

    expect(price?.meterName).toBe('D2s v3');
  });

  it('picks the cheapest eligible meter to keep estimates conservative', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [
          { retailPrice: 0.2, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3 Windows', armRegionName: 'eastus' },
          { retailPrice: 0.1, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3', armRegionName: 'eastus' },
        ],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({ serviceName: 'Virtual Machines', region: 'eastus' });

    expect(price?.amount).toBe(73);
  });

  it('narrows results with a meter name pattern', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [
          { retailPrice: 0.001, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'Data Transfer', armRegionName: 'eastus' },
          { retailPrice: 0.005, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'Standard Static IP Addresses', armRegionName: 'eastus' },
        ],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({
      serviceName: 'Virtual Network',
      region: 'eastus',
      meterNamePattern: /ip address/i,
    });

    expect(price?.meterName).toBe('Standard Static IP Addresses');
  });

  it('requests the currency Azure bills the tenant in', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const service = new PricingService({ currency: 'BRL', fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.getMonthlyPrice({ serviceName: 'Virtual Machines', region: 'brazilsouth' });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('currencyCode=BRL');
  });

  it('escapes single quotes so a SKU name cannot break the filter', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.getMonthlyPrice({ serviceName: "O'Brien", region: 'eastus' });

    expect(decodeURIComponent(String(fetchImpl.mock.calls[0]?.[0]))).toContain("O''Brien");
  });

  it('caches lookups so a report does not repeat the same query', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [{ retailPrice: 0.1, currencyCode: 'USD', unitOfMeasure: '1 Hour', meterName: 'D2s v3', armRegionName: 'eastus' }],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const query = { serviceName: 'Virtual Machines', region: 'eastus', armSkuName: 'Standard_D2s_v3' };

    await service.getMonthlyPrice(query);
    await service.getMonthlyPrice(query);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caches a miss so an unpriceable SKU is not queried repeatedly', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }));
    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const query = { serviceName: 'Virtual Machines', region: 'eastus' };

    expect(await service.getMonthlyPrice(query)).toBeUndefined();
    expect(await service.getMonthlyPrice(query)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns undefined instead of throwing when the API fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response);
    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await service.getMonthlyPrice({ serviceName: 'Virtual Machines', region: 'eastus' })).toBeUndefined();
    expect(service.isUnavailable).toBe(true);
  });

  it('stops calling the API after an outage so the report is not delayed', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await service.getMonthlyPrice({ serviceName: 'Virtual Machines', region: 'eastus' });
    await service.getMonthlyPrice({ serviceName: 'Storage', region: 'westus' });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('ignores meters priced in units that cannot be projected monthly', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [{ retailPrice: 0.05, currencyCode: 'USD', unitOfMeasure: '1 GB', meterName: 'Hot LRS Data Stored', armRegionName: 'eastus' }],
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await service.getMonthlyPrice({ serviceName: 'Storage', region: 'eastus' })).toBeUndefined();
  });
  it('narrows the query server side when an exact meter is known', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [{ retailPrice: 23.96, currencyCode: 'BRL', unitOfMeasure: '1/Month', meterName: 'P10 LRS Disk', armRegionName: 'brazilsouth' }],
      }),
    );

    const service = new PricingService({ currency: 'BRL', fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({ serviceName: 'Storage', region: 'brazilsouth', meterName: 'P10 LRS Disk' });

    expect(price?.amount).toBe(23.96);
    // Storage exposes hundreds of meters per region, so relying on a client-side
    // filter would only ever inspect the first page of results.
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('meterName+eq+%27P10+LRS+Disk%27');
  });

  it('follows pagination so a meter beyond the first page is still found', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          Items: [{ retailPrice: 99, currencyCode: 'USD', unitOfMeasure: '1 GB', meterName: 'Data Stored', armRegionName: 'eastus' }],
          NextPageLink: 'https://prices.azure.com/api/retail/prices?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Items: [{ retailPrice: 10, currencyCode: 'USD', unitOfMeasure: '1/Month', meterName: 'P4 LRS Disk', armRegionName: 'eastus' }],
        }),
      );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const price = await service.getMonthlyPrice({ serviceName: 'Storage', region: 'eastus' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(price?.meterName).toBe('P4 LRS Disk');
  });

  it('stops paging on a query too broad to yield a meaningful price', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        Items: [{ retailPrice: 1, currencyCode: 'USD', unitOfMeasure: '1 GB', meterName: 'Data Stored', armRegionName: 'eastus' }],
        NextPageLink: 'https://prices.azure.com/api/retail/prices?page=next',
      }),
    );

    const service = new PricingService({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await service.getMonthlyPrice({ serviceName: 'Storage', region: 'eastus' });

    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});
