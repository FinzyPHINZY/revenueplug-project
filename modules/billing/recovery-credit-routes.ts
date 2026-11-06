import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { requireAuth } from '../auth/middleware.js';
import {
  getOrganizationContext,
  requireOrganizationContext,
} from '../../shared/middleware/organization-context.js';
import * as recoveryCreditService from './recovery-credit.js';

/**
 * GET /api/billing/recovery-credit
 * Get recovery credit status for current organization
 */
async function handleGetRecoveryCredit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetRecoveryCredit' });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const status = await recoveryCreditService.getRecoveryCreditStatus(organizationId);

    return reply.code(200).send(status);
  } catch (error) {
    log.error({ error }, 'Failed to get recovery credit status');
    return reply.code(500).send({
      error: 'Failed to retrieve recovery credit',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Register recovery credit routes
 */
export async function registerRecoveryCreditRoutes(app: FastifyInstance): Promise<void> {
  // Protected routes
  app.get(
    '/api/billing/recovery-credit',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetRecoveryCredit
  );

  logger.info('Registered recovery credit routes');
}
