import Redis from 'ioredis';
import { config } from '../../shared/config/index.js';
import { logger } from '../../shared/logger/index.js';

let redisClient: Redis | null = null;


export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call connectRedis() first.');
  }
  return redisClient;
}

export function getRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}


export async function connectRedis(): Promise<void> {
  try {
    redisClient = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
    });

    redisClient.on('error', (error) => {
      logger.error({ error }, 'Redis client error');
    });

    redisClient.on('connect', () => {
      logger.debug('Redis client connected');
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready');
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
    });

    redisClient.on('reconnecting', () => {
      logger.info('Redis client reconnecting');
    });

    await redisClient.ping();

    logger.info('Connected to Redis');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to Redis');
    throw error;
  }
}


export async function disconnectRedis(): Promise<void> {
  try {
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
    }
    logger.info('Disconnected from Redis');
  } catch (error) {
    logger.error({ error }, 'Error disconnecting from Redis');
    throw error;
  }
}


export async function checkRedisHealth(): Promise<boolean> {
  try {
    if (!redisClient) {
      return false;
    }

    const pong = await redisClient.ping();
    return pong === 'PONG';
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    return false;
  }
}
