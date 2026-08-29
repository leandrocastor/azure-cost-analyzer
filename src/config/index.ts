import 'dotenv/config';

import { z } from 'zod';

import { ConfigurationError } from '@/utils/errors';

const authMethodSchema = z.enum(['cli', 'service-principal', 'managed-identity']);
const logLevelSchema = z.enum(['error', 'warn', 'info', 'debug']);
const logFormatSchema = z.enum(['auto', 'json', 'text']);

const baseConfigSchema = z.object({
  AZURE_SUBSCRIPTION_ID: z.string().uuid(),
  AZURE_TENANT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_SECRET: z.string().min(1).optional(),
  AUTH_METHOD: authMethodSchema.default('cli'),
  CACHE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  LOG_LEVEL: logLevelSchema.default('info'),
  LOG_FORMAT: logFormatSchema.default('auto'),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const configSchema = baseConfigSchema.superRefine((value, ctx) => {
  if (value.AUTH_METHOD === 'service-principal') {
    if (!value.AZURE_TENANT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AZURE_TENANT_ID'],
        message: 'AZURE_TENANT_ID is required when AUTH_METHOD=service-principal',
      });
    }

    if (!value.AZURE_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AZURE_CLIENT_ID'],
        message: 'AZURE_CLIENT_ID is required when AUTH_METHOD=service-principal',
      });
    }

    if (!value.AZURE_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AZURE_CLIENT_SECRET'],
        message: 'AZURE_CLIENT_SECRET is required when AUTH_METHOD=service-principal',
      });
    }
  }
});

export type AppConfig = z.infer<typeof configSchema>;
export type AuthMethod = z.infer<typeof authMethodSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type LogFormat = z.infer<typeof logFormatSchema>;

let cachedConfig: AppConfig | null = null;

/**
 * Creates a validated runtime configuration from environment variables.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  return parsed.data;
};

/**
 * Returns a cached validated configuration instance.
 */
export const getConfig = (): AppConfig => {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }

  return cachedConfig;
};

/**
 * Clears the cached config, primarily for testing.
 */
export const resetConfig = (): void => {
  cachedConfig = null;
};

export { configSchema };
