/**
 * Retention Campaign Queue Setup
 * BullMQ queue for background processing of campaign actions
 */

import { Queue } from 'bullmq';
import { logger } from '../../shared/logger/index.js';
import type { CampaignAction, ActionPriority } from '@prisma/client';
import type { CampaignActionJobData } from './types.js';

const log = logger.child({ module: 'retention-queue' });

// Queue instance
let retentionQueue: Queue<CampaignActionJobData> | null = null;

/**
 * Get Redis connection config
 */
function getRedisConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  };
}

/**
 * Initialize the retention campaign queue
 */
export function initializeRetentionQueue(): void {
  if (retentionQueue) {
    log.info('Retention queue already initialized');
    return;
  }

  try {
    retentionQueue = new Queue<CampaignActionJobData>('retention-campaigns', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000, // 2s, 4s, 8s
        },
        removeOnComplete: {
          age: 7 * 24 * 3600, // Keep completed jobs for 7 days
          count: 10000, // Keep max 10k completed jobs
        },
        removeOnFail: {
          age: 30 * 24 * 3600, // Keep failed jobs for 30 days
        },
      },
    });

    log.info('Retention queue initialized');
  } catch (error) {
    log.error({ error }, 'Failed to initialize retention queue');
    throw error;
  }
}

/**
 * Map action priority to BullMQ priority number
 * Lower number = higher priority
 */
function actionPriorityToNumber(priority: ActionPriority): number {
  const priorityMap: Record<ActionPriority, number> = {
    IMMEDIATE: 1,
    HIGH: 3,
    MEDIUM: 5,
    LOW: 10,
  };

  return priorityMap[priority];
}

/**
 * Enqueue a campaign action for background processing
 */
export async function enqueueAction(
  action: CampaignAction & { campaign: { priority: ActionPriority; organizationId: string; customer: { id: string } } },
  delayMs: number = 0
): Promise<void> {
  if (!retentionQueue) {
    throw new Error('Retention queue not initialized. Call initializeRetentionQueue() first.');
  }

  const operationLog = log.child({
    operation: 'enqueueAction',
    actionId: action.id,
    actionType: action.actionType,
    campaignId: action.campaignId,
  });

  try {
    const jobData: CampaignActionJobData = {
      actionId: action.id,
      campaignId: action.campaignId,
      customerId: action.campaign.customer.id,
      organizationId: action.campaign.organizationId,
    };

    const job = await retentionQueue.add(
      `action-${action.id}`,
      jobData,
      {
        jobId: action.id, // Use action ID as job ID for idempotency
        delay: Math.max(0, delayMs),
        priority: actionPriorityToNumber(action.campaign.priority),
      }
    );

    operationLog.info(
      {
        jobId: job.id,
        delay: delayMs,
        priority: action.campaign.priority,
        scheduledFor: new Date(Date.now() + delayMs).toISOString(),
      },
      'Action enqueued'
    );
  } catch (error) {
    operationLog.error({ error }, 'Failed to enqueue action');
    throw error;
  }
}

/**
 * Get queue instance (for worker or monitoring)
 */
export function getRetentionQueue(): Queue<CampaignActionJobData> {
  if (!retentionQueue) {
    throw new Error('Retention queue not initialized');
  }

  return retentionQueue;
}

/**
 * Get queue stats
 */
export async function getQueueStats() {
  if (!retentionQueue) {
    throw new Error('Retention queue not initialized');
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    retentionQueue.getWaitingCount(),
    retentionQueue.getActiveCount(),
    retentionQueue.getCompletedCount(),
    retentionQueue.getFailedCount(),
    retentionQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    total: waiting + active + delayed,
  };
}

/**
 * Cleanup queue on shutdown
 */
export async function closeRetentionQueue(): Promise<void> {
  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
    log.info('Retention queue closed');
  }
}
