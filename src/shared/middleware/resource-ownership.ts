import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../infrastructure/postgres/index.js';
import { getOrganizationContext } from './organization-context.js';
import { logger } from '../logger/index.js';

export async function requireConnectionAccess(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'requireConnectionAccess', url: request.url });

  try {
    const { id: organizationId } = getOrganizationContext(request);

    const connectionId =
      (request.params as any).id ||
      (request.params as any).connectionId ||
      (request.query as any).connection_id ||
      (request.body as any)?.connection_id;

    if (!connectionId) {
      log.warn('No connection_id provided');
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'connection_id is required'
      });
    }

    const connection = await prisma.connection.findFirst({
      where: {
        id: connectionId,
        organizationId
      }
    });

    if (!connection) {
      log.warn({ connectionId, organizationId }, 'Connection not found or access denied');
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Connection not found or you do not have access'
      });
    }

    (request as any).connection = connection;

    log.debug({ connectionId, organizationId }, 'Connection access validated');
  } catch (error) {
    log.error({ error }, 'Failed to validate connection access');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to validate connection access'
    });
  }
}

export function getConnection(request: FastifyRequest): any {
  const connection = (request as any).connection;
  if (!connection) {
    throw new Error('Connection not set. Did you forget requireConnectionAccess middleware?');
  }
  return connection;
}
