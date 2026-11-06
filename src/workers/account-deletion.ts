import { type Job, Worker } from 'bullmq';
import { prisma } from '../infrastructure/postgres/index.js';
import { getRedisClient } from '../infrastructure/redis/client.js';
import { getQueue, QueueNames } from '../infrastructure/redis/queues.js';
import { logger } from '../shared/logger/index.js';

const JOB_NAME = 'process-account-deletions';

export async function startAccountDeletionWorker(): Promise<void> {
  const log = logger.child({ worker: 'account-deletion' });

  const queue = getQueue(QueueNames.BACKGROUND);
  await queue.add(
    JOB_NAME,
    {},
    {
      repeat: {
        pattern: '0 3 * * *',
      },
      jobId: 'daily-account-deletion',
    }
  );

  log.info('Scheduled account deletion job (daily at 3 AM)');

  const connection = getRedisClient();
  const worker = new Worker(
    QueueNames.BACKGROUND,
    async (job: Job) => {
      if (job.name === JOB_NAME) {
        await processAccountDeletions();
      }
    },
    { connection }
  );

  worker.on('error', (err) => {
    log.error({ error: err }, 'Account deletion worker error');
  });

  log.info('Account deletion worker started');
}

async function processAccountDeletions(): Promise<void> {
  const log = logger.child({ operation: 'processAccountDeletions' });
  const now = new Date();

  try {
    const pendingDeletions = await prisma.user.findMany({
      where: {
        deletedAt: {
          lte: now,
        },
      },
      select: { id: true, email: true },
    });

    if (pendingDeletions.length === 0) {
      log.info('No accounts pending deletion');
      return;
    }

    log.info({ count: pendingDeletions.length }, 'Processing account deletions');

    let deletedCount = 0;
    let failedCount = 0;

    for (const user of pendingDeletions) {
      try {
        await prisma.user.delete({ where: { id: user.id } });
        deletedCount++;
      } catch (err) {
        log.error({ userId: user.id, error: err }, 'Failed to delete user');
        failedCount++;
      }
    }

    log.info({ deletedCount, failedCount }, 'Finished processing account deletions');
  } catch (err) {
    log.error({ error: err }, 'Failed to fetch pending deletions');
    throw err;
  }
}
