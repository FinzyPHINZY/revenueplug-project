import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import { getOrganizationContext, requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import { enforceApiUsageLimit } from '../../shared/middleware/usage-limits.js';
import { requireAuth } from '../auth/middleware.js';
import { getConnection } from '../connections/service.js';
import { Platform } from '../../shared/types/index.js';
import { cancelSyncJob, enqueueSyncJob, getSyncJobStatus } from './queue.js';

/**
 * Sync job routes for monitoring and triggering syncs
 */

// ==========================================================================
// REQUEST SCHEMAS
// ==========================================================================

const JobParamsSchema = z.object({
  job_id: z.string().min(1),
});

const TriggerSyncBodySchema = z.object({
  connection_id: z.string().min(1),
  platform: z.nativeEnum(Platform),
});

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * GET /api/sync/jobs/:job_id
 * Get sync job status
 */
async function handleGetJobStatus(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetJobStatus' });

  try {
    const { job_id } = JobParamsSchema.parse(request.params);

    const status = await getSyncJobStatus(job_id);

    log.info({ job_id, status: status.status }, 'Retrieved job status');

    return reply.code(200).send({
      job_id,
      ...status,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get job status');
    return reply.code(500).send({
      error: 'Failed to retrieve job status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/sync/trigger
 * Manually trigger a sync job
 */
async function handleTriggerSync(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleTriggerSync' });

  try {
    const body = TriggerSyncBodySchema.parse(request.body);

    // Get organization ID from context
    const { id: organizationId } = getOrganizationContext(request);

    // Validate connection belongs to organization
    const connection = await getConnection(body.connection_id, organizationId);

    if (!connection) {
      return reply.code(404).send({
        error: 'Connection not found',
        message: 'Connection does not exist or you do not have access',
      });
    }

    const jobId = await enqueueSyncJob(body.connection_id, body.platform, 'manual');

    log.info(
      {
        job_id: jobId,
        connection_id: body.connection_id,
        organization_id: organizationId,
        platform: body.platform,
      },
      'Sync job triggered'
    );

    return reply.code(202).send({
      job_id: jobId,
      connection_id: body.connection_id,
      platform: body.platform,
      message: 'Sync job has been queued',
      status_url: `/api/sync/jobs/${jobId}`,
    });
  } catch (error) {
    log.error({ error }, 'Failed to trigger sync');
    return reply.code(500).send({
      error: 'Failed to trigger sync',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * DELETE /api/sync/jobs/:job_id
 * Cancel a sync job
 */
async function handleCancelJob(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCancelJob' });

  try {
    const { job_id } = JobParamsSchema.parse(request.params);

    await cancelSyncJob(job_id);

    log.info({ job_id }, 'Job cancelled');

    return reply.code(200).send({
      job_id,
      message: 'Sync job cancelled successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to cancel job');
    return reply.code(500).send({
      error: 'Failed to cancel job',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  // Job status routes (require auth only)
  app.get(
    '/api/sync/jobs/:job_id',
    { preHandler: requireAuth },
    handleGetJobStatus
  );

  app.delete(
    '/api/sync/jobs/:job_id',
    { preHandler: requireAuth },
    handleCancelJob
  );

  // Trigger sync route (require auth + organization context + API usage limit)
  app.post(
    '/api/sync/trigger',
    { preHandler: [requireAuth, requireOrganizationContext, enforceApiUsageLimit] },
    handleTriggerSync
  );

  logger.info('Registered sync routes');
}
