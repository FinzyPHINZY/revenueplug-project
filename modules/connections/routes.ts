import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { platformRegistry } from '../../platforms/registry.js';
import { logger } from '../../shared/logger/index.js';
import { getOrganizationContext, requireOrganizationContext } from '../../shared/middleware/organization-context.js';
import { enforceConnectionLimit } from '../../shared/middleware/usage-limits.js';
import { AuthType, type Platform } from '../../shared/types/index.js';
import {  requireAuth } from '../auth/middleware.js';
import { enqueueSyncJob } from '../sync/index.js';
import * as connectionService from './service.js';

/**
 * Connection routes for OAuth and API key integrations
 */

// ==========================================================================
// REQUEST SCHEMAS
// ==========================================================================

const AuthorizeQuerySchema = z.object({
  redirect_uri: z.string().url(),
});

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const ApiKeyBodySchema = z.object({
  api_key: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const ConnectionParamsSchema = z.object({
  id: z.string().min(1),
});

// ==========================================================================
// ROUTE HANDLERS
// ==========================================================================

/**
 * POST /api/connections/:platform/authorize
 * Initiates OAuth flow by generating authorization URL
 */
async function handleAuthorize(
  request: FastifyRequest<{
    Params: { platform: string };
    Querystring: z.infer<typeof AuthorizeQuerySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({
    operation: 'handleAuthorize',
    platform: request.params.platform,
  });

  try {
    const { redirect_uri } = AuthorizeQuerySchema.parse(request.query);
    const platform = request.params.platform.toUpperCase() as Platform;

    // Get platform adapter
    const adapter = platformRegistry.getAdapter(platform);

    // Check if platform supports OAuth
    if (!adapter.supportedAuthTypes.includes(AuthType.OAUTH)) {
      return reply.code(400).send({
        error: 'OAuth not supported',
        message: `Platform ${platform} does not support OAuth authentication`,
      });
    }

    // Generate state for CSRF protection
    const state = randomUUID();

    // TODO: Store state in Redis with expiry for validation in callback
    // await storeOAuthState(state, { platform, redirect_uri });

    // Generate OAuth URL
    const authUrl = adapter.getOAuthUrl(state, redirect_uri);

    log.info({ platform, state }, 'Generated OAuth authorization URL');

    return reply.code(200).send({
      auth_url: authUrl,
      state,
      platform,
    });
  } catch (error) {
    log.error({ error }, 'Failed to generate authorization URL');
    return reply.code(500).send({
      error: 'Authorization failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/connections/:platform/callback
 * Handles OAuth callback, exchanges code for token, creates connection
 */
async function handleCallback(
  request: FastifyRequest<{
    Params: { platform: string };
    Querystring: z.infer<typeof CallbackQuerySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({
    operation: 'handleCallback',
    platform: request.params.platform,
  });

  try {
    const { code, state } = CallbackQuerySchema.parse(request.query);
    const platform = request.params.platform.toUpperCase() as Platform;

    // TODO: Validate state from Redis
    // const storedState = await getOAuthState(state);
    // if (!storedState) {
    //   return reply.code(400).send({ error: 'Invalid state' });
    // }

    log.info({ platform, state }, 'Processing OAuth callback');

    // Get platform adapter
    const adapter = platformRegistry.getAdapter(platform);

    // Exchange code for credentials
    const credentials = await adapter.exchangeOAuthCode(code, '');

    // Get organization ID from authenticated user context
    const { id: organizationId } = getOrganizationContext(request);

    // Create connection with encrypted credentials
    const connection = await connectionService.createConnection({
      organizationId,
      platform,
      authType: AuthType.OAUTH,
      credentials,
      metadata: credentials.metadata,
    });

    log.info(
      {
        connection_id: connection.id,
        platform,
        organization_id: organizationId,
      },
      'Successfully created OAuth connection'
    );

    // Trigger initial sync job
    const jobId = await enqueueSyncJob(connection.id, platform, 'oauth_callback');

    log.info({ connection_id: connection.id, job_id: jobId }, 'Initial sync job enqueued');

    return reply.code(201).send({
      connection_id: connection.id,
      platform,
      status: connection.status,
      auth_type: connection.authType,
      created_at: connection.createdAt,
      sync_job_id: jobId,
      message: 'Connection created successfully. Initial sync has been queued.',
    });
  } catch (error) {
    log.error({ error }, 'OAuth callback failed');
    return reply.code(500).send({
      error: 'Callback failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * POST /api/connections/:platform/api-key
 * Creates connection using API key authentication
 */
async function handleApiKeyConnection(
  request: FastifyRequest<{
    Params: { platform: string };
    Body: z.infer<typeof ApiKeyBodySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({
    operation: 'handleApiKeyConnection',
    platform: request.params.platform,
  });

  try {
    const body = ApiKeyBodySchema.parse(request.body);
    const platform = request.params.platform.toUpperCase() as Platform;

    // Get platform adapter
    const adapter = platformRegistry.getAdapter(platform);

    // Check if platform supports API key auth
    if (!adapter.supportedAuthTypes.includes(AuthType.API_KEY)) {
      return reply.code(400).send({
        error: 'API key not supported',
        message: `Platform ${platform} does not support API key authentication`,
      });
    }

    // Get organization ID from authenticated user context
    const { id: organizationId } = getOrganizationContext(request);

    log.info({ platform, organization_id: organizationId }, 'Validating API key');

    // Validate API key
    const isValid = await adapter.validateApiKey(body.api_key);
    if (!isValid) {
      log.warn({ platform }, 'Invalid API key provided');
      return reply.code(401).send({
        error: 'Invalid API key',
        message: 'The provided API key is invalid or expired',
      });
    }

    // Create connection
    const connection = await connectionService.createConnection({
      organizationId,
      platform,
      authType: AuthType.API_KEY,
      credentials: {
        api_key: body.api_key,
      },
      metadata: body.metadata,
    });

    log.info(
      {
        connection_id: connection.id,
        platform,
        organization_id: organizationId,
      },
      'Successfully created API key connection'
    );

    // Trigger initial sync job
    const jobId = await enqueueSyncJob(connection.id, platform, 'manual');

    log.info({ connection_id: connection.id, job_id: jobId }, 'Initial sync job enqueued');

    return reply.code(201).send({
      connection_id: connection.id,
      platform,
      status: connection.status,
      auth_type: connection.authType,
      created_at: connection.createdAt,
      sync_job_id: jobId,
      message: 'Connection created successfully. Initial sync has been queued.',
    });
  } catch (error) {
    log.error({ error }, 'API key connection failed');
    return reply.code(500).send({
      error: 'Connection failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/connections/:id
 * Get connection details (without credentials)
 */
async function handleGetConnection(
  request: FastifyRequest<{
    Params: z.infer<typeof ConnectionParamsSchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetConnection' });

  try {
    const { id } = ConnectionParamsSchema.parse(request.params);

    // Get organization ID from context
    const { id: organizationId } = getOrganizationContext(request);

    // Get connection with organization validation
    const connection = await connectionService.getConnection(id, organizationId);

    if (!connection) {
      return reply.code(404).send({
        error: 'Connection not found',
        message: `Connection with ID ${id} does not exist or you do not have access`,
      });
    }

    log.info({ connection_id: id, organization_id: organizationId }, 'Retrieved connection details');

    // Return connection without credentials
    return reply.code(200).send({
      id: connection.id,
      organization_id: connection.organizationId,
      platform: connection.platform,
      auth_type: connection.authType,
      status: connection.status,
      last_synced_at: connection.lastSyncedAt,
      created_at: connection.createdAt,
      updated_at: connection.updatedAt,
      metadata: connection.metadata,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get connection');
    return reply.code(500).send({
      error: 'Failed to retrieve connection',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * GET /api/connections/:id/status
 * Get connection sync status
 */
async function handleGetConnectionStatus(
  request: FastifyRequest<{
    Params: z.infer<typeof ConnectionParamsSchema>;
    Querystring: { job_id?: string };
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleGetConnectionStatus' });

  try {
    const { id } = ConnectionParamsSchema.parse(request.params);
    const jobId = request.query.job_id;

    // Get organization ID from context
    const { id: organizationId } = getOrganizationContext(request);

    // Get connection with organization validation
    const connection = await connectionService.getConnection(id, organizationId);

    if (!connection) {
      return reply.code(404).send({
        error: 'Connection not found',
        message: `Connection with ID ${id} does not exist or you do not have access`,
      });
    }

    log.info({ connection_id: id, organization_id: organizationId }, 'Retrieved connection status');

    // Return basic status (job status requires job_id parameter)
    return reply.code(200).send({
      connection_id: id,
      status: connection.status,
      last_synced_at: connection.lastSyncedAt,
      sync_status: {
        message: jobId
          ? 'Use GET /api/sync/jobs/:job_id to check sync job status'
          : 'Provide job_id query parameter to check specific sync job',
      },
    });
  } catch (error) {
    log.error({ error }, 'Failed to get connection status');
    return reply.code(500).send({
      error: 'Failed to retrieve status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ==========================================================================
// ROUTE REGISTRATION
// ==========================================================================

export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  // OAuth routes (require auth + organization context)
  app.post<{
    Params: { platform: string };
    Querystring: z.infer<typeof AuthorizeQuerySchema>;
  }>(
    '/api/connections/:platform/authorize',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleAuthorize
  );

  app.get<{
    Params: { platform: string };
    Querystring: z.infer<typeof CallbackQuerySchema>;
  }>(
    '/api/connections/:platform/callback',
    { preHandler: [requireAuth, requireOrganizationContext, enforceConnectionLimit] },
    handleCallback
  );

  // API key routes (require auth + organization context + connection limit)
  app.post<{
    Params: { platform: string };
    Body: z.infer<typeof ApiKeyBodySchema>;
  }>(
    '/api/connections/:platform/api-key',
    { preHandler: [requireAuth, requireOrganizationContext, enforceConnectionLimit] },
    handleApiKeyConnection
  );

  // Connection management (require auth + organization context)
  app.get<{
    Params: z.infer<typeof ConnectionParamsSchema>;
  }>(
    '/api/connections/:id',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetConnection
  );

  app.get<{
    Params: z.infer<typeof ConnectionParamsSchema>;
    Querystring: { job_id?: string };
  }>(
    '/api/connections/:id/status',
    { preHandler: [requireAuth, requireOrganizationContext] },
    handleGetConnectionStatus
  );

  logger.info('Registered connection routes');
}
