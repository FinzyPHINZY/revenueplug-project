import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { config } from '../config/index.js';

const baseLogger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export const logger = {
  withCorrelationId: (correlationId?: string) => {
    const id = correlationId || randomUUID();
    return baseLogger.child({ correlationId: id });
  },

  child: (bindings: Record<string, unknown>) => {
    return baseLogger.child(bindings);
  },

  trace: baseLogger.trace.bind(baseLogger),
  debug: baseLogger.debug.bind(baseLogger),
  info: baseLogger.info.bind(baseLogger),
  warn: baseLogger.warn.bind(baseLogger),
  error: baseLogger.error.bind(baseLogger),
  fatal: baseLogger.fatal.bind(baseLogger),
};

export function generateCorrelationId(): string {
  return randomUUID();
}

export type Logger = typeof logger;
