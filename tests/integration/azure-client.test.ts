import {
  ClientSecretCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { AzureClientService } from '@/services/azure-client';
import { AzureApiError, AzureAuthError, ConfigurationError } from '@/utils/errors';
import { validEnv } from '../fixtures/mock-data';

const listSubscriptionsMock = vi.fn();

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(function () {
    return { kind: 'default' };
  }),
  ClientSecretCredential: vi.fn(function () {
    return { kind: 'client-secret' };
  }),
  ManagedIdentityCredential: vi.fn(function () {
    return { kind: 'managed-identity' };
  }),
}));

vi.mock('@azure/arm-subscriptions', () => ({
  SubscriptionClient: vi.fn(function () {
    return { subscriptions: { list: listSubscriptionsMock } };
  }),
}));

const asAsyncIterable = <T>(items: T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: async function* () {
    for (const item of items) {
      yield item;
    }
  },
});

describe('AzureClientService', () => {
  beforeEach(() => {
    AzureClientService.clearCredentialCache();
  });

  it('creates default credentials for cli auth', () => {
    const service = new AzureClientService({ ...validEnv, AUTH_METHOD: 'cli' });
    expect(service.getCredential()).toEqual({ kind: 'default' });
    expect(DefaultAzureCredential).toHaveBeenCalledOnce();
  });

  it('creates client secret credentials for service principal auth', () => {
    const service = new AzureClientService(validEnv);
    expect(service.getCredential()).toEqual({ kind: 'client-secret' });
    expect(ClientSecretCredential).toHaveBeenCalledWith(
      validEnv.AZURE_TENANT_ID,
      validEnv.AZURE_CLIENT_ID,
      validEnv.AZURE_CLIENT_SECRET,
    );
  });

  it('creates managed identity credentials', () => {
    const service = new AzureClientService({ ...validEnv, AUTH_METHOD: 'managed-identity' });
    expect(service.getCredential()).toEqual({ kind: 'managed-identity' });
    expect(ManagedIdentityCredential).toHaveBeenCalledWith({ clientId: validEnv.AZURE_CLIENT_ID });
  });

  it('creates managed-identity credentials without AZURE_CLIENT_ID', () => {
    const envWithoutClientId = { ...validEnv, AUTH_METHOD: 'managed-identity' as const, AZURE_CLIENT_ID: undefined };
    const service = new AzureClientService(envWithoutClientId);
    expect(service.getCredential()).toEqual({ kind: 'managed-identity' });
    expect(ManagedIdentityCredential).toHaveBeenCalledWith(undefined);
  });

  it('caches credentials by auth configuration', () => {
    const service = new AzureClientService(validEnv);
    const first = service.getCredential();
    const second = service.getCredential();
    expect(first).toBe(second);
  });

  it('returns subscription overrides', () => {
    const service = new AzureClientService(validEnv);
    expect(service.getSubscriptionId('override')).toBe('override');
  });

  it('returns configured subscription id when no override is provided', () => {
    const service = new AzureClientService(validEnv);
    expect(service.getSubscriptionId()).toBe(validEnv.AZURE_SUBSCRIPTION_ID);
  });

  it('throws a configuration error when no subscription can be resolved', () => {
    const service = new AzureClientService({ ...validEnv, AZURE_SUBSCRIPTION_ID: undefined });
    expect(() => service.getSubscriptionId()).toThrow(ConfigurationError);
  });

  it('returns undefined from getConfiguredSubscriptionId when unset', () => {
    const service = new AzureClientService({ ...validEnv, AZURE_SUBSCRIPTION_ID: undefined });
    expect(service.getConfiguredSubscriptionId()).toBeUndefined();
  });

  it('lists enabled subscriptions accessible to the credential', async () => {
    listSubscriptionsMock.mockReturnValueOnce(
      asAsyncIterable([
        { subscriptionId: 'sub-1', displayName: 'Production', state: 'Enabled' },
        { subscriptionId: 'sub-2', displayName: 'Disabled Sub', state: 'Disabled' },
        { subscriptionId: 'sub-3', displayName: 'Sandbox', state: 'Enabled' },
      ]),
    );
    const service = new AzureClientService(validEnv);
    const subscriptions = await service.listAccessibleSubscriptions();
    expect(subscriptions).toEqual([
      { id: 'sub-1', displayName: 'Production' },
      { id: 'sub-3', displayName: 'Sandbox' },
    ]);
  });

  it('throws when no enabled subscriptions are found', async () => {
    listSubscriptionsMock.mockReturnValueOnce(asAsyncIterable([]));
    const service = new AzureClientService(validEnv);
    await expect(service.listAccessibleSubscriptions()).rejects.toThrow(AzureAuthError);
  });

  it('wraps subscription listing failures', async () => {
    listSubscriptionsMock.mockImplementationOnce(() => {
      throw new Error('network error');
    });
    const service = new AzureClientService(validEnv);
    await expect(service.listAccessibleSubscriptions()).rejects.toThrow(AzureAuthError);
  });

  it('wraps credential creation errors', () => {
    vi.mocked(DefaultAzureCredential).mockImplementationOnce(function () {
      throw new Error('bad auth');
    });
    const service = new AzureClientService({ ...validEnv, AUTH_METHOD: 'cli' });
    expect(() => service.getCredential()).toThrow(AzureAuthError);
  });

  it('retries Azure operations through executeWithRetry', async () => {
    let attempts = 0;
    const service = new AzureClientService(validEnv, { sleep: async () => undefined, maxAttempts: 2 });
    const result = await service.executeWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new AzureApiError('retry', 500);
      }
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('exhausts all retry attempts and rethrows the last error', async () => {
    const service = new AzureClientService(validEnv, { sleep: async () => undefined, maxAttempts: 3 });
    let attempts = 0;
    await expect(
      service.executeWithRetry(async () => {
        attempts += 1;
        throw new AzureApiError(`attempt ${attempts}`, 503);
      }),
    ).rejects.toThrow(AzureApiError);
    expect(attempts).toBe(3);
  });
});
