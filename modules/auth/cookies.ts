/**
 * Cookie utilities for JWT token management
 * Secure HTTP-only cookies for access and refresh tokens
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { config } from '../../shared/config/index.js';

// Cookie names
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const REFRESH_TOKEN_COOKIE = 'refresh_token';

/**
 * Parse expiry string (e.g., '15m', '7d') to seconds for cookie maxAge
 */
function parseExpiryToSeconds(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid expiry format: ${expiry}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    throw new Error(`Invalid expiry unit: ${unit}`);
  }

  return value * multiplier;
}

/**
 * Get common cookie options
 */
function getCookieOptions(maxAge: number) {
  const isProduction = config.NODE_ENV === 'production';
  return {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? ('strict' as const) : ('lax' as const),
    maxAge,
  };
}

/**
 * Set access token cookie (short-lived)
 *
 * @param reply - Fastify reply object
 * @param token - JWT access token
 */
export function setAccessTokenCookie(reply: FastifyReply, token: string): void {
  const maxAge = parseExpiryToSeconds(config.JWT_ACCESS_EXPIRY);
  reply.setCookie(ACCESS_TOKEN_COOKIE, token, getCookieOptions(maxAge));
}

/**
 * Set refresh token cookie (longer-lived)
 *
 * @param reply - Fastify reply object
 * @param token - Refresh token
 */
export function setRefreshTokenCookie(reply: FastifyReply, token: string): void {
  const maxAge = parseExpiryToSeconds(config.JWT_REFRESH_EXPIRY);
  reply.setCookie(REFRESH_TOKEN_COOKIE, token, getCookieOptions(maxAge));
}

/**
 * Clear both auth cookies on logout
 *
 * @param reply - Fastify reply object
 */
export function clearAuthCookies(reply: FastifyReply): void {
  const clearOptions = {
    path: '/',
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: config.NODE_ENV === 'production' ? ('strict' as const) : ('lax' as const),
    maxAge: 0,
  };

  reply.setCookie(ACCESS_TOKEN_COOKIE, '', clearOptions);
  reply.setCookie(REFRESH_TOKEN_COOKIE, '', clearOptions);
}

/**
 * Get access token from cookies
 *
 * @param request - Fastify request object
 * @returns Access token or undefined
 */
export function getAccessTokenFromCookies(request: FastifyRequest): string | undefined {
  return request.cookies[ACCESS_TOKEN_COOKIE];
}

/**
 * Get refresh token from cookies
 *
 * @param request - Fastify request object
 * @returns Refresh token or undefined
 */
export function getRefreshTokenFromCookies(request: FastifyRequest): string | undefined {
  return request.cookies[REFRESH_TOKEN_COOKIE];
}
