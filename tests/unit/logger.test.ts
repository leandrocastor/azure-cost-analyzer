import { createLogger, resolveLoggerFormat } from '@/utils/logger';

describe('logger', () => {
  it('creates a logger with the requested level', () => {
    const logger = createLogger({}, { LOG_LEVEL: 'debug', LOG_FORMAT: 'text', NODE_ENV: 'test' });
    expect(logger.level).toBe('debug');
  });

  it('creates child loggers with inherited context', () => {
    const logger = createLogger({ service: 'test' }, { LOG_FORMAT: 'text', NODE_ENV: 'test' });
    const child = logger.child({ operation: 'run' });
    expect(child).toBeDefined();
    expect(child.level).toBe(logger.level);
  });

  it('uses json formatter in production auto mode', () => {
    const formatter = resolveLoggerFormat({ LOG_FORMAT: 'auto', NODE_ENV: 'production' });
    const transformed = formatter.transform?.({ level: 'info', message: 'hello' }, formatter.options);
    expect(transformed).toMatchObject({ level: 'info', message: 'hello' });
  });

  it('uses json formatter when explicitly requested', () => {
    const formatter = resolveLoggerFormat({ LOG_FORMAT: 'json', NODE_ENV: 'development' });
    const transformed = formatter.transform?.({ level: 'info', message: 'hello' }, formatter.options);
    expect(transformed).toMatchObject({ level: 'info', message: 'hello' });
  });

  it('uses text formatter for development auto mode', () => {
    const formatter = resolveLoggerFormat({ LOG_FORMAT: 'auto', NODE_ENV: 'development' });
    expect(formatter).toBeDefined();
    expect(typeof formatter.transform).toBe('function');
  });

  it('uses text formatter when explicitly requested', () => {
    const formatter = resolveLoggerFormat({ LOG_FORMAT: 'text', NODE_ENV: 'production' });
    expect(formatter).toBeDefined();
    expect(typeof formatter.transform).toBe('function');
  });

  it.each(['error', 'warn', 'info', 'debug'])('supports log level %s', (level) => {
    const logger = createLogger({}, { LOG_LEVEL: level, LOG_FORMAT: 'text', NODE_ENV: 'test' });
    expect(logger.level).toBe(level);
  });
});
