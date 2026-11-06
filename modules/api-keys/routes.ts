
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger/index.js';
import { requireAuth } from '../auth/middleware.js';
import { requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import {
  createAPIKey,
  listAPIKeys,
  getAPIKey,
  revokeAPIKey,
  deleteAPIKey,
  API_SCOPES,
} from './service.js';


const CreateAPIKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresInDays: z.number().min(1).max(365).optional(),
});

const APIKeyParamsSchema = z.object({
  key_id: z.string(),
});

async function handleCreateAPIKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleCreateAPIKey' });

  try {
    const organizationId = (request as any).organizationId;
    const user = (request as any).user;
    const body = CreateAPIKeySchema.parse(request.body);

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;

    const apiKey = await createAPIKey({
      organizationId,
      createdBy: user.id,
      name: body.name,
      scopes: body.scopes,
      expiresAt,
    });

    log.info({ keyId: apiKey.id, name: apiKey.name }, 'Created API key');

    return reply.code(201).send({
      id: apiKey.id,
      name: apiKey.name,
      key_prefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      enabled: apiKey.enabled,
      expires_at: apiKey.expiresAt?.toISOString() || null,
      created_at: apiKey.createdAt.toISOString(),
      secret: apiKey.secret, // ONLY returned once
      warning: 'Save this API key now. You will not be able to see it again.',
    });
  } catch (error) {
    log.error({ error }, 'Failed to create API key');
    return reply.code(500).send({
      error: 'Failed to create API key',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleListAPIKeys(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleListAPIKeys' });

  try {
    const organizationId = (request as any).organizationId;

    const keys = await listAPIKeys(organizationId);

    log.info({ organizationId, count: keys.length }, 'Listed API keys');

    return reply.code(200).send({
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        key_prefix: key.keyPrefix,
        scopes: key.scopes,
        enabled: key.enabled,
        expires_at: key.expiresAt?.toISOString() || null,
        last_used_at: key.lastUsedAt?.toISOString() || null,
        usage_count: key.usageCount,
        created_at: key.createdAt.toISOString(),
        updated_at: key.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    log.error({ error }, 'Failed to list API keys');
    return reply.code(500).send({
      error: 'Failed to list API keys',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function handleGetAPIKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetAPIKey' });

  try {
    const organizationId = (request as any).organizationId;
    const { key_id } = APIKeyParamsSchema.parse(request.params);

    const key = await getAPIKey(key_id, organizationId);

    if (!key) {
      return reply.code(404).send({
        error: 'API key not found',
      });
    }

    log.info({ keyId: key_id }, 'Retrieved API key');

    return reply.code(200).send({
      id: key.id,
      name: key.name,
      key_prefix: key.keyPrefix,
      scopes: key.scopes,
      enabled: key.enabled,
      expires_at: key.expiresAt?.toISOString() || null,
      last_used_at: key.lastUsedAt?.toISOString() || null,
      usage_count: key.usageCount,
      created_at: key.createdAt.toISOString(),
      updated_at: key.updatedAt.toISOString(),
    });
  } catch (error) {
    log.error({ error }, 'Failed to get API key');
    return reply.code(500).send({
      error: 'Failed to get API key',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


async function handleDeleteAPIKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteAPIKey' });

  try {
    const organizationId = (request as any).organizationId;
    const { key_id } = APIKeyParamsSchema.parse(request.params);

    await revokeAPIKey(key_id, organizationId);

    log.info({ keyId: key_id }, 'Revoked API key');

    return reply.code(200).send({
      message: 'API key revoked successfully',
    });
  } catch (error) {
    log.error({ error }, 'Failed to revoke API key');
    return reply.code(500).send({
      error: 'Failed to revoke API key',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


async function handleListScopes(
  _request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  return reply.code(200).send({
    scopes: [
      {
        scope: API_SCOPES.READ_CUSTOMERS,
        description: 'Read customer data',
      },
      {
        scope: API_SCOPES.READ_SUBSCRIPTIONS,
        description: 'Read subscription data',
      },
      {
        scope: API_SCOPES.READ_INVOICES,
        description: 'Read invoice data',
      },
      {
        scope: API_SCOPES.READ_CAMPAIGNS,
        description: 'Read retention campaigns',
      },
      {
        scope: API_SCOPES.READ_ANALYTICS,
        description: 'Read analytics and detection data',
      },
      {
        scope: API_SCOPES.READ_SETTINGS,
        description: 'Read organization settings',
      },
      {
        scope: API_SCOPES.WRITE_CUSTOMERS,
        description: 'Create and update customers',
      },
      {
        scope: API_SCOPES.WRITE_CAMPAIGNS,
        description: 'Create and manage campaigns',
      },
      {
        scope: API_SCOPES.WRITE_SETTINGS,
        description: 'Update organization settings',
      },
      {
        scope: API_SCOPES.ADMIN,
        description: 'Full access to all resources',
      },
    ],
  });
}


export async function registerAPIKeyRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = [requireAuth, requireOrganizationContext];

  app.post('/api/api-keys', { preHandler }, handleCreateAPIKey);
  app.get('/api/api-keys', { preHandler }, handleListAPIKeys);
  app.get('/api/api-keys/scopes', { preHandler: [requireAuth] }, handleListScopes);
  app.get('/api/api-keys/:key_id', { preHandler }, handleGetAPIKey);
  app.delete('/api/api-keys/:key_id', { preHandler }, handleDeleteAPIKey);

  logger.info('Registered API key routes');
}
