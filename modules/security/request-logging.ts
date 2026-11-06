/**
 * Request/Response Logging
 * Logs all API requests with correlation IDs for debugging
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { logger } from '../../shared/logger/index.js';

/**
 * Register request/response logging hooks
 */
export function registerRequestLogging(app: FastifyInstance): void {
  // Add correlation ID to all requests
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Generate correlation ID (or use existing from X-Request-ID header)
    const correlationId =
      (request.headers['x-request-id'] as string) || randomUUID();

    // Attach to request
    (request as any).correlationId = correlationId;

    // Add to response headers
    reply.header('X-Request-ID', correlationId);

    // Create request-specific logger
    (request as any).log = logger.child({
      correlationId,
      method: request.method,
      url: request.url,
      ip: request.ip,
    });
  });

  // Log request start
  app.addHook('onRequest', async (request: FastifyRequest) => {
    const log = (request as any).log;

    log.info(
      {
        method: request.method,
        url: request.url,
        headers: sanitizeHeaders(request.headers),
        query: request.query,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      },
      'Request started'
    );
  });

  // Log response
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const log = (request as any).log;
    const responseTime = reply.elapsedTime;

    log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: `${responseTime.toFixed(2)}ms`,
      },
      'Request completed'
    );
  });

  // Log errors
  app.addHook('onError', async (request: FastifyRequest, _reply, error) => {
    const log = (request as any).log;

    log.error(
      {
        method: request.method,
        url: request.url,
        error: {
          message: error.message,
          stack: error.stack,
          code: (error as any).code,
        },
      },
      'Request error'
    );
  });

  logger.info('Request/response logging configured');
}

/**
 * Sanitize headers to remove sensitive data from logs
 */
function sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
  const sanitized = { ...headers };

  // Remove sensitive headers
  const sensitiveHeaders = [
    'authorization',
    'cookie',
    'x-api-key',
    'x-webhook-signature',
  ];

  for (const header of sensitiveHeaders) {
    if (sanitized[header]) {
      sanitized[header] = '[REDACTED]';
    }
  }

  return sanitized;
}

/**
 * Log slow requests (> 1 second)
 */
export function registerSlowRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const responseTime = reply.elapsedTime;

    if (responseTime > 1000) {
      // > 1 second
      const log = (request as any).log;

      log.warn(
        {
          method: request.method,
          url: request.url,
          responseTime: `${responseTime.toFixed(2)}ms`,
          userId: (request as any).user?.id,
          organizationId: (request as any).organizationId,
        },
        'Slow request detected'
      );
    }
  });

  logger.info('Slow request logging configured (> 1s threshold)');
}

/**
 * Get correlation ID from request
 */
export function getCorrelationId(request: FastifyRequest): string {
  return (request as any).correlationId || 'unknown';
}
