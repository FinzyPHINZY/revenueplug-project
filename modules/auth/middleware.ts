/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger/index.js';
import { getAccessTokenFromCookies } from './cookies.js';
import { verifyAccessToken } from './tokens.js';

/**
 * Authenticated user information attached to request
 */
export interface AuthUser {
  userId: string;
  email: string;
  accountId: string;
}

/**
 * Fastify middleware to require authentication
 * Extracts JWT from access_token cookie (preferred) or Authorization header (fallback)
 * Verifies token and attaches user to request
 *
 * Usage in routes:
 * ```typescript
 * app.get('/api/users/me', { preHandler: requireAuth }, handler);
 * ```
 *
 * Access authenticated user in handler:
 * ```typescript
 * const user = getAuthUser(request);
 * ```
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'requireAuth', url: request.url });

  try {
    // Try to get token from cookie first (browser clients)
    let token = getAccessTokenFromCookies(request);

    // Fallback to Authorization header (API clients)
    if (!token) {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      log.warn('No access token found in cookies or Authorization header');

      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    // Verify and decode token
    const payload = verifyAccessToken(token);

    // Attach user info to request
    (request as any).user = {
      userId: payload.userId,
      email: payload.email,
    };

    log.debug({ userId: payload.userId }, 'User authenticated');
  } catch (error) {
    log.warn({ error }, 'Authentication failed');

    return reply.code(401).send({
      error: 'Unauthorized',
      message: error instanceof Error ? error.message : 'Invalid or expired token',
    });
  }
}

/**
 * Helper to get authenticated user from request
 * TypeScript-safe way to access request.user set by requireAuth middleware
 *
 * @param request - Fastify request object
 * @returns Authenticated user information
 * @throws Error if user is not authenticated (middleware not applied)
 *
 * @example
 * const { userId, email, accountId } = getAuthUser(request);
 */
export function getAuthUser(request: FastifyRequest): AuthUser {
  const user = (request as any).user;

  if (!user) {
    throw new Error('User not authenticated - did you forget requireAuth middleware?');
  }

  return user as AuthUser;
}
