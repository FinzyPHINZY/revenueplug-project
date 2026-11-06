/**
 * Retention Campaign Worker
 * BullMQ worker that processes campaign actions in the background
 */

import { Worker, Job } from 'bullmq';
import { logger } from '../../shared/logger/index.js';
import { executeAction } from './service.js';
import type { CampaignActionJobData } from './types.js';

const log = logger.child({ module: 'retention-worker' });

// Worker instance
let retentionWorker: Worker<CampaignActionJobData> | null = null;

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
 * Initialize the retention campaign worker
 */
export async function initializeRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    log.info('Retention worker already initialized');
    return;
  }

  try {
    retentionWorker = new Worker<CampaignActionJobData>(
      'retention-campaigns',
      async (job: Job<CampaignActionJobData>) => {
        const { actionId, campaignId, customerId, organizationId } = job.data;

        const jobLog = log.child({
          jobId: job.id,
          actionId,
          campaignId,
          customerId,
          organizationId,
        });

        jobLog.info('Processing campaign action');

        try {
          // Execute the action
          const result = await executeAction(actionId);

          if (result.success) {
            jobLog.info({ result: result.result }, 'Campaign action completed successfully');

            // Evaluate branch conditions for sequence progression
            const { evaluateBranchConditions } = await import('./sequences.js');
            await evaluateBranchConditions(actionId).catch((error) => {
              jobLog.error({ error }, 'Failed to evaluate branch conditions');
              // Don't fail the job if branch evaluation fails
            });

            return result;
          }

          // If not successful, throw error to trigger retry
          const error = new Error(result.error || 'Action execution failed');
          jobLog.error({ error }, 'Campaign action failed');
          throw error;
        } catch (error) {
          jobLog.error({ error }, 'Worker error while processing campaign action');
          throw error;
        }
      },
      {
        connection: getRedisConnection(),
        concurrency: 10, // Process up to 10 jobs concurrently
        limiter: {
          max: 50, // Max 50 jobs
          duration: 1000, // Per second
        },
      }
    );

    // Event handlers
    retentionWorker.on('completed', (job) => {
      log.info(
        {
          jobId: job.id,
          actionId: job.data.actionId,
          duration: job.finishedOn ? job.finishedOn - (job.processedOn || job.finishedOn) : 0,
        },
        'Job completed'
      );
    });

    retentionWorker.on('failed', (job, error) => {
      log.error(
        {
          jobId: job?.id,
          actionId: job?.data.actionId,
          error: error.message,
          attemptsMade: job?.attemptsMade,
          attemptsMax: job?.opts.attempts,
        },
        'Job failed'
      );
    });

    retentionWorker.on('error', (error) => {
      log.error({ error }, 'Worker error');
    });

    retentionWorker.on('stalled', (jobId) => {
      log.warn({ jobId }, 'Job stalled');
    });

    log.info('Retention worker initialized');
  } catch (error) {
    log.error({ error }, 'Failed to initialize retention worker');
    throw error;
  }
}

/**
 * Get worker instance
 */
export function getRetentionWorker(): Worker<CampaignActionJobData> {
  if (!retentionWorker) {
    throw new Error('Retention worker not initialized');
  }

  return retentionWorker;
}

/**
 * Pause the worker
 */
export async function pauseRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.pause();
    log.info('Retention worker paused');
  }
}

/**
 * Resume the worker
 */
export async function resumeRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.resume();
    log.info('Retention worker resumed');
  }
}

/**
 * Cleanup worker on shutdown
 */
export async function closeRetentionWorker(): Promise<void> {
  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
    log.info('Retention worker closed');
  }
}
