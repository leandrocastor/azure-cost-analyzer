import { getConfig, loadConfig, resetConfig } from '@/config';
import { ConfigurationError } from '@/utils/errors';
import { validEnv } from '../fixtures/mock-data';

describe('config', () => {
  beforeEach(() => {
    resetConfig();
  });

  it('loads a valid service principal configuration', () => {
    expect(loadConfig(validEnv).AUTH_METHOD).toBe('service-principal');
  });

  it('applies defaults for optional settings', () => {
    const config = loadConfig({ ...validEnv, AUTH_METHOD: 'cli', AZURE_CLIENT_SECRET: undefined });
    expect(config.CACHE_TTL_MINUTES).toBe(15);
    expect(config.DASHBOARD_PORT).toBe(3000);
  });

  it('caches configuration via getConfig', () => {
    process.env = { ...process.env, ...validEnv };
    const first = getConfig();
    const second = getConfig();
    expect(first).toBe(second);
  });

  it.each([
    ['AZURE_SUBSCRIPTION_ID', 'not-a-uuid'],
    ['DATA_MODE', 'unsupported'],
    ['AUTH_METHOD', 'unsupported'],
    ['LOG_LEVEL', 'trace'],
    ['LOG_FORMAT', 'yaml'],
    ['DASHBOARD_PORT', '70000'],
    ['CACHE_TTL_MINUTES', '-1'],
  ])('rejects invalid %s values', (key, value) => {
    const env = { ...validEnv, [key]: value };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  it.each([
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_ID',
    'AZURE_CLIENT_SECRET',
  ])('requires %s for service principal auth', (key) => {
    const env = { ...validEnv, [key]: undefined };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  it('allows mock mode without Azure credentials', () => {
    const config = loadConfig({
      DATA_MODE: 'mock',
      AUTH_METHOD: 'cli',
      NODE_ENV: 'test',
    });
    expect(config.DATA_MODE).toBe('mock');
    expect(config.AZURE_SUBSCRIPTION_ID).toBeUndefined();
  });

  it('requires subscription id when DATA_MODE=azure', () => {
    const env = { ...validEnv, AZURE_SUBSCRIPTION_ID: undefined, DATA_MODE: 'azure' as const };
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
  });

  it('does not require client secret for cli auth', () => {
    const config = loadConfig({
      ...validEnv,
      AUTH_METHOD: 'cli',
      AZURE_CLIENT_SECRET: undefined,
      AZURE_CLIENT_ID: undefined,
      AZURE_TENANT_ID: undefined,
    });
    expect(config.AUTH_METHOD).toBe('cli');
  });

  it('supports managed identity auth', () => {
    const config = loadConfig({
      ...validEnv,
      AUTH_METHOD: 'managed-identity',
      AZURE_CLIENT_SECRET: undefined,
    });
    expect(config.AUTH_METHOD).toBe('managed-identity');
  });
});
