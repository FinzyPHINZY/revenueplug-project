

import type { FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { verifyAPIKey, hasScope } from './service.js';

export async function authenticateAPIKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'authenticateAPIKey' });

  try {
    let apiKey = request.headers['x-api-key'] as string | undefined;

    if (!apiKey) {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith('rp_')) {
          apiKey = token;
        }
      }
    }

    if (!apiKey) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'API key required. Provide via X-API-Key header or Authorization: Bearer header',
      });
    }

    const verification = await verifyAPIKey(apiKey);

    if (!verification.valid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired API key',
      });
    }

    (request as any).organizationId = verification.organizationId;
    (request as any).apiKeyScopes = verification.scopes;
    (request as any).apiKeyId = verification.keyId;
    (request as any).authenticatedVia = 'api_key';

    log.debug(
      {
        organizationId: verification.organizationId,
        keyId: verification.keyId,
      },
      'API key authenticated'
    );
  } catch (error) {
    log.error({ error }, 'API key authentication failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Authentication failed',
    });
  }
}


export function requireScope(scope: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const scopes = (request as any).apiKeyScopes as string[] | undefined;

    if (!scopes) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'API key authentication required',
      });
    }

    if (!hasScope(scopes, scope)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `This operation requires the '${scope}' scope`,
      });
    }
  };
}


export async function optionalAPIKey(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (apiKey) {
    const verification = await verifyAPIKey(apiKey);

    if (verification.valid) {
      (request as any).organizationId = verification.organizationId;
      (request as any).apiKeyScopes = verification.scopes;
      (request as any).apiKeyId = verification.keyId;
      (request as any).authenticatedVia = 'api_key';
    }
  }
}
