import { CostAnalyzerService } from '@/services/cost-analyzer';
import { QpuLimiter } from '@/utils/qpu-limiter';
import { retry } from '@/utils/retry';

const transport = vi.hoisted(() => ({ sendRequest: vi.fn() }));

vi.mock('@azure/arm-costmanagement', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@azure/arm-costmanagement')>();
  return {
    ...sdk,
    CostManagementClient: class extends sdk.CostManagementClient {
      public constructor(
        credential: ConstructorParameters<typeof sdk.CostManagementClient>[0],
        options: ConstructorParameters<typeof sdk.CostManagementClient>[1],
      ) {
        super(credential, { ...options, httpClient: transport, retryOptions: { maxRetries: 0 } });
      }
    },
  };
});

describe('Cost Management pagination through the real SDK pipeline', () => {
  it('POSTs every nextLink with the original serialized body, authentication and throttling control', async () => {
    const calls: {
      url: string;
      method: string;
      body: string;
      authorization: string | undefined;
    }[] = [];
    const endpoint =
      'https://management.azure.com/subscriptions/sub/providers/Microsoft.CostManagement/query';
    const continuation = `${endpoint}?api-version=2025-03-01&$skiptoken=page%2B2%2F%3D`;
    let failed = false;
    transport.sendRequest.mockImplementation(
      async (request: {
        url: string;
        method: string;
        body: string;
        headers: { get: (name: string) => string | undefined };
      }) => {
        calls.push({
          url: request.url,
          method: request.method,
          body: request.body,
          authorization: request.headers.get('authorization'),
        });
        const onSecondPage = request.url === continuation;
        if (onSecondPage && !failed) {
          failed = true;
          return {
            request,
            status: 429,
            headers: {
              get: (name: string) => (name.toLowerCase() === 'retry-after' ? '1' : undefined),
              toJSON: () => ({ 'retry-after': '1' }),
              contains: () => false,
            },
            bodyAsText: JSON.stringify({
              error: { code: 'TooManyRequests', message: 'Throttled' },
            }),
          };
        }
        return {
          request,
          status: 200,
          headers: request.headers,
          bodyAsText: JSON.stringify({
            properties: {
              columns: [
                { name: 'PreTaxCost', type: 'Number' },
                { name: 'Currency', type: 'String' },
                { name: 'ServiceName', type: 'String' },
              ],
              rows: [[onSecondPage ? -15 : 100, 'USD', 'Compute']],
              nextLink: onSecondPage ? null : continuation,
            },
          }),
        };
      },
    );
    const credential = {
      getToken: vi.fn(async () => ({
        token: 'synthetic-test-token',
        expiresOnTimestamp: Date.now() + 3600000,
      })),
    };
    const sleep = vi.fn(async () => undefined);
    const limiter = new QpuLimiter({ windows: [], sleep });
    const acquire = vi.spyOn(limiter, 'acquire');
    const penalize = vi.spyOn(limiter, 'penalize');
    const service = new CostAnalyzerService(
      {
        getCredential: () => credential,
        executeWithRetry: async <T>(operation: () => Promise<T>): Promise<T> =>
          retry(operation, { sleep, maxAttempts: 2 }),
      } as never,
      limiter,
    );

    const summary = await service.queryCosts('sub', '2026-01-01', '2026-01-31', 'service');

    expect(summary.totalAmount).toBe(85);
    expect(summary.byService).toEqual({ Compute: 85 });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.url)).toEqual([
      `${endpoint.replace('/subscriptions/', '//subscriptions/')}?api-version=2025-03-01`,
      continuation,
      continuation,
    ]);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);
    expect(calls.every((call) => call.body === calls[0]!.body)).toBe(true);
    expect(calls.every((call) => call.authorization === 'Bearer synthetic-test-token')).toBe(true);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      type: 'ActualCost',
      dataset: {
        granularity: 'None',
        aggregation: { totalCost: { name: 'PreTaxCost', function: 'Sum' } },
      },
    });
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(penalize).toHaveBeenCalledWith(1000);
    expect(sleep).toHaveBeenCalled();
  });
});
