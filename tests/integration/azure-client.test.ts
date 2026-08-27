import {
  ClientSecretCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';

import { AzureClientService } from '@/services/azure-client';
import { AzureApiError, AzureAuthError } from '@/utils/errors';
import { validEnv } from '../fixtures/mock-data';

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
});
