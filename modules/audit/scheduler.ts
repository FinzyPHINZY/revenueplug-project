/**
 * Audit Log Scheduler
 * Automated retention policy enforcement and cleanup
 */

import { CronJob } from 'cron';
import { logger } from '../../shared/logger/index.js';
import { archiveExpiredLogs, deleteArchivedLogs } from './service.js';

// ============================================================================
// CRON JOBS
// ============================================================================

/**
 * Daily job to archive expired audit logs
 * Runs at 2:00 AM every day
 */
export const archiveLogsJob = new CronJob(
  '0 2 * * *', // 2:00 AM daily
  async () => {
    const log = logger.child({ operation: 'archiveLogsJob' });

    try {
      log.info('Starting audit log archival job');

      const count = await archiveExpiredLogs();

      log.info({ count }, 'Completed audit log archival job');
    } catch (error) {
      log.error({ error }, 'Audit log archival job failed');
    }
  },
  null, // onComplete
  false, // start immediately
  'UTC' // timezone
);

/**
 * Weekly job to delete old archived logs
 * Runs at 3:00 AM every Sunday
 * Deletes logs archived for more than 2 years
 */
export const deleteArchivedLogsJob = new CronJob(
  '0 3 * * 0', // 3:00 AM every Sunday
  async () => {
    const log = logger.child({ operation: 'deleteArchivedLogsJob' });

    try {
      log.info('Starting archived audit log deletion job');

      // Delete logs archived for more than 2 years (730 days)
      const count = await deleteArchivedLogs(730);

      log.info({ count }, 'Completed archived audit log deletion job');
    } catch (error) {
      log.error({ error }, 'Archived audit log deletion job failed');
    }
  },
  null, // onComplete
  false, // start immediately
  'UTC' // timezone
);

// ============================================================================
// SCHEDULER CONTROL
// ============================================================================

/**
 * Start all audit log cron jobs
 */
export function startAuditScheduler(): void {
  logger.info('Starting audit log scheduler');

  archiveLogsJob.start();
  deleteArchivedLogsJob.start();

  logger.info('Audit log scheduler started');
}

/**
 * Stop all audit log cron jobs
 */
export function stopAuditScheduler(): void {
  logger.info('Stopping audit log scheduler');

  archiveLogsJob.stop();
  deleteArchivedLogsJob.stop();

  logger.info('Audit log scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getAuditSchedulerStatus(): {
  archiveJob: { running: boolean; nextRun: Date | null };
  deleteJob: { running: boolean; nextRun: Date | null };
} {
  return {
    archiveJob: {
      running: archiveLogsJob.running,
      nextRun: archiveLogsJob.nextDate()?.toJSDate() || null,
    },
    deleteJob: {
      running: deleteArchivedLogsJob.running,
      nextRun: deleteArchivedLogsJob.nextDate()?.toJSDate() || null,
    },
  };
}
