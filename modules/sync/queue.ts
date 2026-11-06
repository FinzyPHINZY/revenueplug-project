/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/noNonNullAssertion: <> */

import { Queue } from 'bullmq';
import { getRedisConnection } from '../../infrastructure/redis/client.js';
import { logger } from '../../shared/logger/index.js';
import type { Platform } from '../../shared/types/index.js';
import type { SyncJobData } from './worker.js';

/**
 * Sync Queue Manager
 * Enqueues sync jobs for background processing
 */

let syncQueue: Queue<SyncJobData> | null = null;

/**
 * Initialize sync queue
 */
export function initializeSyncQueue(): void {
  syncQueue = new Queue<SyncJobData>('sync', {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3, // Retry up to 3 times
      backoff: {
        type: 'exponential',
        delay: 5000, // Start with 5s, then 25s, then 125s
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000, // Keep last 1000 completed jobs
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      },
    },
  });

  logger.info('Sync queue initialized');
}

/**
 * Enqueue a sync job for a connection
 */
export async function enqueueSyncJob(
  connectionId: string,
  platform: Platform,
  triggeredBy: SyncJobData['triggeredBy'] = 'manual'
): Promise<string> {
  if (!syncQueue) {
    throw new Error('Sync queue not initialized');
  }

  const log = logger.child({
    operation: 'enqueueSyncJob',
    connectionId,
    platform,
  });

  try {
    const job = await syncQueue.add(
      `sync-${connectionId}`,
      {
        connectionId,
        platform,
        triggeredBy,
      },
      {
        jobId: `sync-${connectionId}-${Date.now()}`,
        priority: triggeredBy === 'oauth_callback' ? 1 : 10, // OAuth callbacks get higher priority
      }
    );

    log.info({ jobId: job.id }, 'Sync job enqueued');
    return job.id!;
  } catch (error) {
    log.error({ error }, 'Failed to enqueue sync job');
    throw error;
  }
}

/**
 * Get sync job status
 */
export async function getSyncJobStatus(jobId: string): Promise<{
  status:
    | 'waiting'
    | 'active'
    | 'completed'
    | 'failed'
    | 'delayed'
    | 'paused'
    | 'prioritized'
    | 'unknown';
  progress?: number;
  result?: any;
  error?: string;
}> {
  if (!syncQueue) {
    throw new Error('Sync queue not initialized');
  }

  const job = await syncQueue.getJob(jobId);

  if (!job) {
    return { status: 'unknown' };
  }

  const state = await job.getState();
  const progress = job.progress;
  const returnValue = job.returnvalue;
  const failedReason = job.failedReason;

  // Map state to our return type
  const validStates = [
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused',
    'prioritized',
  ] as const;
  const mappedState = validStates.includes(state as any)
    ? (state as (typeof validStates)[number])
    : 'unknown';

  return {
    status: mappedState,
    progress: typeof progress === 'number' ? progress : undefined,
    result: returnValue,
    error: failedReason,
  };
}

/**
 * Cancel a sync job
 */
export async function cancelSyncJob(jobId: string): Promise<void> {
  if (!syncQueue) {
    throw new Error('Sync queue not initialized');
  }

  const job = await syncQueue.getJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  await job.remove();
  logger.info({ jobId }, 'Sync job cancelled');
}

/**
 * Close sync queue gracefully
 */
export async function closeSyncQueue(): Promise<void> {
  if (syncQueue) {
    await syncQueue.close();
    logger.info('Sync queue closed');
  }
}
