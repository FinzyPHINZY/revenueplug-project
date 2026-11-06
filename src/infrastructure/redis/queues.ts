import { Queue, type QueueOptions } from 'bullmq';
import { logger } from '../../shared/logger/index.js';
import { Platform } from '../../shared/types/index.js';
import { getRedisClient } from './client.js';

export const QueueNames = {
  SYNC_STRIPE: 'sync_stripe',
  SYNC_POLAR: 'sync_polar',
  SYNC_REVENUECAT: 'sync_revenuecat',
  SYNC_LEMON_SQUEEZY: 'sync_lemon_squeezy',

  WEBHOOKS: 'webhooks',

  EVENT_OUTBOX: 'event_outbox',

  TOKEN_REFRESH: 'token_refresh',

  BACKGROUND: 'background',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

const queues: Map<QueueName, Queue> = new Map();

export function getSyncQueueForPlatform(platform: Platform): QueueName {
  const queueMap: Record<Platform, QueueName> = {
    [Platform.STRIPE]: QueueNames.SYNC_STRIPE,
    [Platform.POLAR]: QueueNames.SYNC_POLAR,
    [Platform.REVENUECAT]: QueueNames.SYNC_REVENUECAT,
    [Platform.LEMON_SQUEEZY]: QueueNames.SYNC_LEMON_SQUEEZY,
  };

  return queueMap[platform];
}

function createQueue(name: QueueName, options?: Partial<QueueOptions>): Queue {
  const connection = getRedisClient();

  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 3600,
      },
      removeOnFail: {
        count: 1000,
      },
    },
    ...options,
  });

  queue.on('error', (error) => {
    logger.error({ queue: name, error }, 'Queue error');
  });

  return queue;
}

export async function initializeQueues(): Promise<void> {
  try {
    logger.info('Initializing BullMQ queues');

    queues.set(QueueNames.SYNC_STRIPE, createQueue(QueueNames.SYNC_STRIPE));
    queues.set(QueueNames.SYNC_POLAR, createQueue(QueueNames.SYNC_POLAR));
    queues.set(QueueNames.SYNC_REVENUECAT, createQueue(QueueNames.SYNC_REVENUECAT));
    queues.set(QueueNames.SYNC_LEMON_SQUEEZY, createQueue(QueueNames.SYNC_LEMON_SQUEEZY));

    queues.set(
      QueueNames.WEBHOOKS,
      createQueue(QueueNames.WEBHOOKS, {
        defaultJobOptions: {
          attempts: 5,
        },
      })
    );

    queues.set(
      QueueNames.EVENT_OUTBOX,
      createQueue(QueueNames.EVENT_OUTBOX, {
        defaultJobOptions: {
          attempts: 10,
        },
      })
    );

    queues.set(QueueNames.TOKEN_REFRESH, createQueue(QueueNames.TOKEN_REFRESH));

    queues.set(QueueNames.BACKGROUND, createQueue(QueueNames.BACKGROUND));

    logger.info({ count: queues.size }, 'BullMQ queues initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to initialize BullMQ queues');
    throw error;
  }
}

export function getQueue(name: QueueName): Queue {
  const queue = queues.get(name);

  if (!queue) {
    throw new Error(`Queue not found: ${name}`);
  }

  return queue;
}

export async function closeQueues(): Promise<void> {
  try {
    const closePromises = Array.from(queues.values()).map((queue) => queue.close());
    await Promise.all(closePromises);
    queues.clear();

    logger.info('All BullMQ queues closed');
  } catch (error) {
    logger.error({ error }, 'Error closing BullMQ queues');
    throw error;
  }
}

export function getAllQueueNames(): QueueName[] {
  return Array.from(queues.keys());
}
