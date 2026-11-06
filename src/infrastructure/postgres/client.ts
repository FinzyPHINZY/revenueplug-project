import { PrismaClient } from '@prisma/client';
import { logger } from '../../shared/logger/index.js';

export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('query', (e) => {
  logger.debug({ query: e.query, duration: e.duration }, 'Database query executed');
});

prisma.$on('error', (e) => {
  logger.error({ error: e }, 'Database error');
});

prisma.$on('warn', (e) => {
  logger.warn({ message: e.message }, 'Database warning');
});

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Connected to Postgres database');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to Postgres database');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Disconnected from Postgres database');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from Postgres database');
    throw error;
  }
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return false;
  }
}
