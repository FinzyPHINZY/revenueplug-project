import { type Job, Worker } from 'bullmq';
import { getRedisConnection } from '../../infrastructure/redis/client.js';
import { logger } from '../../shared/logger/index.js';
import type { Platform } from '../../shared/types/index.js';
import { syncConnection } from './service.js';

/**
 * Sync Worker
 * Processes background sync jobs from BullMQ
 */

export interface SyncJobData {
  connectionId: string;
  platform: Platform;
  triggeredBy: 'oauth_callback' | 'manual' | 'scheduled';
}

let syncWorker: Worker<SyncJobData> | null = null;

/**
 * Initialize sync worker
 */
export async function initializeSyncWorker(): Promise<void> {
  const log = logger.child({ worker: 'sync' });

  syncWorker = new Worker<SyncJobData>(
    'sync',
    async (job: Job<SyncJobData>) => {
      const { connectionId, platform, triggeredBy } = job.data;

      const jobLog = logger.child({
        jobId: job.id,
        connectionId,
        platform,
        triggeredBy,
      });

      jobLog.info('Processing sync job');

      try {
        // Pass progress callback to sync service
        const result = await syncConnection(connectionId, async (progress) => {
          // Update job progress with detailed info
          await job.updateProgress({
            percentage: progress.percentage,
            stage: progress.stage,
            counts: progress.counts,
            message: progress.message,
          });

          jobLog.info(
            {
              percentage: progress.percentage,
              stage: progress.stage,
              counts: progress.counts,
            },
            progress.message
          );
        });

        jobLog.info(
          {
            ...result,
            duration: `${result.duration}ms`,
          },
          'Sync job completed successfully'
        );

        return result;
      } catch (error) {
        jobLog.error({ error }, 'Sync job failed');
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5, // Process up to 5 syncs concurrently
      limiter: {
        max: 10, // Max 10 jobs
        duration: 1000, // Per second (rate limiting)
      },
    }
  );

  // Event handlers
  syncWorker.on('completed', (job: Job<SyncJobData>) => {
    log.info({ jobId: job.id, connectionId: job.data.connectionId }, 'Sync job completed');
  });

  syncWorker.on('failed', (job: Job<SyncJobData> | undefined, error: Error) => {
    log.error(
      {
        jobId: job?.id,
        connectionId: job?.data.connectionId,
        error,
      },
      'Sync job failed'
    );
  });

  syncWorker.on('error', (error: Error) => {
    log.error({ error }, 'Sync worker error');
  });

  log.info('Sync worker initialized');
}

/**
 * Close sync worker gracefully
 */
export async function closeSyncWorker(): Promise<void> {
  if (syncWorker) {
    await syncWorker.close();
    logger.info('Sync worker closed');
  }
}
