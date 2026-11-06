/**
 * Retention Scheduled Jobs
 *
 * Background jobs to be run on a schedule (via cron, BullMQ scheduler, or cloud scheduler)
 *
 * Jobs:
 * - Daily metrics aggregation
 * - Weekly/monthly metrics aggregation
 * - Payment failure prediction processing
 * - Campaign cleanup and expiration
 */

import { logger } from '../../shared/logger/index.js';
import { runDailyAggregation } from './metrics-aggregation.js';
import { processPaymentPredictions } from './triggers/payment-prediction-trigger.js';
import { prisma } from '../../infrastructure/postgres/index.js';

const log = logger.child({ module: 'retention-scheduled-jobs' });

/**
 * Run daily metrics aggregation
 * Schedule: Daily at 1:00 AM
 */
export async function runDailyMetricsJob(): Promise<void> {
  const operationLog = log.child({ job: 'daily-metrics-aggregation' });

  try {
    operationLog.info('Starting daily metrics aggregation job');
    const startTime = Date.now();

    await runDailyAggregation();

    const duration = Date.now() - startTime;
    operationLog.info({ durationMs: duration }, 'Daily metrics aggregation completed');
  } catch (error) {
    operationLog.error({ error }, 'Daily metrics aggregation job failed');
    throw error;
  }
}

/**
 * Process payment failure predictions and trigger campaigns
 * Schedule: Daily at 6:00 AM (run after metrics aggregation)
 *
 * Scans all organizations for upcoming invoices with high failure risk
 * and triggers preventive retention campaigns
 */
export async function runPaymentPredictionJob(): Promise<void> {
  const operationLog = log.child({ job: 'payment-prediction-processing' });

  try {
    operationLog.info('Starting payment prediction processing job');
    const startTime = Date.now();

    // Get all organizations with active retention strategies
    const organizations = await prisma.organization.findMany({
      where: {
        retentionStrategies: {
          some: {
            status: 'ACTIVE',
            triggerConditions: {
              path: '$.paymentFailurePredicted',
              equals: true,
            },
          },
        },
      },
      select: { id: true, name: true },
    });

    operationLog.info(
      { organizationsCount: organizations.length },
      'Processing payment predictions for organizations'
    );

    let totalProcessed = 0;
    let totalCampaigns = 0;
    let totalErrors = 0;

    // Process predictions for each organization
    for (const org of organizations) {
      try {
        const result = await processPaymentPredictions(org.id, 30);
        totalProcessed += result.processed;
        totalCampaigns += result.campaignsTriggered;
        totalErrors += result.errors;

        operationLog.info(
          {
            organizationId: org.id,
            organizationName: org.name,
            predictionsProcessed: result.processed,
            campaignsTriggered: result.campaignsTriggered,
            errors: result.errors,
          },
          'Organization payment predictions processed'
        );
      } catch (error) {
        operationLog.error(
          { organizationId: org.id, error },
          'Failed to process predictions for organization'
        );
        totalErrors++;
      }
    }

    const duration = Date.now() - startTime;
    operationLog.info(
      {
        organizationsProcessed: organizations.length,
        totalPredictions: totalProcessed,
        totalCampaigns,
        totalErrors,
        durationMs: duration,
      },
      'Payment prediction processing completed'
    );
  } catch (error) {
    operationLog.error({ error }, 'Payment prediction processing job failed');
    throw error;
  }
}

/**
 * Clean up expired campaigns and actions
 * Schedule: Daily at 2:00 AM
 *
 * Marks old campaigns as completed/expired and cleans up stale data
 */
export async function runCampaignCleanupJob(): Promise<void> {
  const operationLog = log.child({ job: 'campaign-cleanup' });

  try {
    operationLog.info('Starting campaign cleanup job');
    const startTime = Date.now();

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Mark old ACTIVE campaigns as COMPLETED if they have no pending actions
    const result = await prisma.$transaction(async (tx) => {
      // Find campaigns older than 30 days with no pending actions
      const oldCampaigns = await tx.campaign.findMany({
        where: {
          status: 'ACTIVE',
          startedAt: {
            lt: thirtyDaysAgo,
          },
        },
        include: {
          actions: {
            where: {
              status: {
                in: ['PENDING', 'SCHEDULED'],
              },
            },
          },
        },
      });

      const campaignsToComplete = oldCampaigns.filter(
        (c) => c.actions.length === 0
      );

      if (campaignsToComplete.length > 0) {
        await tx.campaign.updateMany({
          where: {
            id: {
              in: campaignsToComplete.map((c) => c.id),
            },
          },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
          },
        });
      }

      return {
        campaignsCompleted: campaignsToComplete.length,
        campaignsChecked: oldCampaigns.length,
      };
    });

    const duration = Date.now() - startTime;
    operationLog.info(
      {
        ...result,
        durationMs: duration,
      },
      'Campaign cleanup completed'
    );
  } catch (error) {
    operationLog.error({ error }, 'Campaign cleanup job failed');
    throw error;
  }
}

/**
 * Remove expired cooldown records
 * Schedule: Daily at 3:00 AM
 */
export async function runCooldownCleanupJob(): Promise<void> {
  const operationLog = log.child({ job: 'cooldown-cleanup' });

  try {
    operationLog.info('Starting cooldown cleanup job');
    const startTime = Date.now();

    const now = new Date();

    // Delete cooldowns that have expired
    const result = await prisma.campaignCooldown.deleteMany({
      where: {
        cooldownEndsAt: {
          lt: now,
        },
      },
    });

    const duration = Date.now() - startTime;
    operationLog.info(
      {
        cooldownsDeleted: result.count,
        durationMs: duration,
      },
      'Cooldown cleanup completed'
    );
  } catch (error) {
    operationLog.error({ error }, 'Cooldown cleanup job failed');
    throw error;
  }
}

/**
 * Run all scheduled retention jobs
 * Useful for testing or manual execution
 */
export async function runAllRetentionJobs(): Promise<void> {
  const operationLog = log.child({ job: 'run-all-retention-jobs' });

  try {
    operationLog.info('Running all retention jobs');

    await runDailyMetricsJob();
    await runPaymentPredictionJob();
    await runCampaignCleanupJob();
    await runCooldownCleanupJob();

    operationLog.info('All retention jobs completed successfully');
  } catch (error) {
    operationLog.error({ error }, 'Failed to run all retention jobs');
    throw error;
  }
}
