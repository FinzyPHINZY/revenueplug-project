/**
 * Rate Limiting
 * Protect API from abuse with configurable rate limits
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { logger } from '../../shared/logger/index.js';
import { redis } from '../../infrastructure/redis/index.js';

/**
 * Register rate limiting middleware
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 100, // 100 requests
    timeWindow: '1 minute',
    cache: 10000, // Cache up to 10k keys
    allowList: ['127.0.0.1'], // Whitelist localhost
    redis, // Use Redis for distributed rate limiting
    skipOnError: true, // Don't block requests if Redis is down
    keyGenerator: (request: FastifyRequest) => {
      // Rate limit by API key if present
      const apiKey = request.headers['x-api-key'];
      if (apiKey) {
        return `api-key:${apiKey}`;
      }

      // Rate limit by user ID if authenticated
      const user = (request as any).user;
      if (user) {
        return `user:${user.id}`;
      }

      // Rate limit by IP address for unauthenticated requests
      return `ip:${request.ip}`;
    },
    errorResponseBuilder: (_request, context) => {
      return {
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
        statusCode: 429,
        retryAfter: Math.ceil(context.ttl / 1000),
      };
    },
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  logger.info('Rate limiting configured (100 req/min global, Redis-backed)');
}

/**
 * Strict rate limit for authentication endpoints
 * Prevents brute force attacks
 */
export async function strictAuthRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = `auth:${request.ip}`;
  const limit = 5; // 5 attempts
  const window = 15 * 60; // 15 minutes

  try {
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, window);
    }

    if (current > limit) {
      const ttl = await redis.ttl(key);

      return reply.code(429).send({
        error: 'Too Many Requests',
        message: `Too many authentication attempts. Try again in ${Math.ceil(ttl / 60)} minutes.`,
        statusCode: 429,
        retryAfter: ttl,
      });
    }
  } catch (error) {
    logger.error({ error }, 'Rate limit check failed');
    // Don't block request if Redis is down
  }
}

/**
 * Relaxed rate limit for webhooks
 * Higher limits for platform webhooks
 */
export async function webhookRateLimit(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = `webhook:${request.ip}`;
  const limit = 1000; // 1000 requests
  const window = 60; // 1 minute

  try {
    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, window);
    }

    if (current > limit) {
      const ttl = await redis.ttl(key);

      return reply.code(429).send({
        error: 'Too Many Requests',
        message: 'Webhook rate limit exceeded',
        statusCode: 429,
        retryAfter: ttl,
      });
    }
  } catch (error) {
    logger.error({ error }, 'Webhook rate limit check failed');
    // Don't block webhook if Redis is down
  }
}

/**
 * Custom rate limit for specific routes
 */
export function createCustomRateLimit(max: number, timeWindowMs: number) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = (request as any).user;
    const key = user ? `custom:${user.id}:${request.url}` : `custom:${request.ip}:${request.url}`;
    const window = Math.ceil(timeWindowMs / 1000);

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, window);
      }

      if (current > max) {
        const ttl = await redis.ttl(key);

        return reply.code(429).send({
          error: 'Too Many Requests',
          message: `Rate limit exceeded for this endpoint`,
          statusCode: 429,
          retryAfter: ttl,
        });
      }
    } catch (error) {
      logger.error({ error }, 'Custom rate limit check failed');
    }
  };
}
