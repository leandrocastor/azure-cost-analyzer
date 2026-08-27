import {
  createLogger as createWinstonLogger,
  format,
  transports,
  type Logger,
  type Logform,
} from 'winston';

import { getConfig, type AppConfig, type LogLevel } from '@/config';
import { ConfigurationError } from '@/utils/errors';

export type LogContext = Record<string, string | number | boolean | null | undefined>;

export const resolveLoggerFormat = (
  config: Pick<AppConfig, 'LOG_FORMAT' | 'NODE_ENV'>,
): Logform.Format => {
  if (config.LOG_FORMAT === 'json' || (config.LOG_FORMAT === 'auto' && config.NODE_ENV === 'production')) {
    return format.combine(format.timestamp(), format.errors({ stack: true }), format.json());
  }

  return format.combine(
    format.colorize(),
    format.timestamp(),
    format.printf(({ level, message, timestamp, ...meta }) => {
      const context = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${String(timestamp)} ${level}: ${String(message)}${context}`;
    }),
  );
};

/**
 * Creates a structured application logger.
 */
export const createLogger = (
  context: LogContext = {},
  overrides: Partial<Pick<AppConfig, 'LOG_FORMAT' | 'LOG_LEVEL' | 'NODE_ENV'>> = {},
): Logger => {
  const config = {
    LOG_FORMAT: 'auto',
    LOG_LEVEL: 'info',
    NODE_ENV: 'development',
    ...(() => {
      try {
        return getConfig();
      } catch (error: unknown) {
        if (error instanceof ConfigurationError) {
          return {};
        }
        throw error;
      }
    })(),
    ...overrides,
  } as Pick<AppConfig, 'LOG_FORMAT' | 'LOG_LEVEL' | 'NODE_ENV'>;
  return createWinstonLogger({
    level: config.LOG_LEVEL as LogLevel,
    defaultMeta: context,
    format: resolveLoggerFormat(config),
    transports: [new transports.Console()],
  });
};

export const logger = createLogger();

/**
 * Returns a child logger enriched with request or service context.
 */
export const getChildLogger = (context: LogContext): Logger => logger.child(context);
