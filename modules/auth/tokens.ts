import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../shared/config/index.js';

/**
 * JWT payload for access tokens
 * Note: No organizationId - users can belong to multiple organizations
 * Organization context determined per-request via middleware
 */
export interface AccessTokenPayload {
  userId: string;
  email: string;
}

/**
 * Generate JWT access token
 *
 * @param user - User information to encode in token
 * @returns Signed JWT token (expires in JWT_ACCESS_EXPIRY, default 15min)
 *
 * @example
 * const token = generateAccessToken({
 *   id: 'user123',
 *   email: 'user@example.com'
 * });
 * // => 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
 */
export function generateAccessToken(user: { id: string; email: string }): string {
  const payload: AccessTokenPayload = {
    userId: user.id,
    email: user.email,
  };

  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRY,
    issuer: 'revenueplug',
    subject: user.id,
  } as jwt.SignOptions);
}

/**
 * Generate refresh token (random cryptographically secure string)
 *
 * @returns Object with unhashed token and expiry date
 *
 * @example
 * const { token, expiresAt } = generateRefreshToken();
 * // => { token: '7f3c4e2a...', expiresAt: Date(...) }
 */
export function generateRefreshToken(): {
  token: string;
  expiresAt: Date;
} {
  // Generate 32-byte random token
  const token = randomBytes(32).toString('hex');

  // Calculate expiry from JWT_REFRESH_EXPIRY (e.g., '7d')
  const expiresAt = new Date();
  const expiryMs = parseExpiry(config.JWT_REFRESH_EXPIRY);
  expiresAt.setTime(expiresAt.getTime() + expiryMs);

  return { token, expiresAt };
}

/**
 * Verify and decode JWT access token
 *
 * @param token - JWT token to verify
 * @returns Decoded token payload
 * @throws Error if token is invalid or expired
 *
 * @example
 * const payload = verifyAccessToken(token);
 * // => { userId: 'user123', email: 'user@example.com', accountId: 'acc456' }
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'revenueplug',
    } as jwt.VerifyOptions) as AccessTokenPayload;

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Access token expired');
    }
    if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid access token');
    }
    throw new Error('Token verification failed');
  }
}

/**
 * Hash refresh token for database storage
 * Uses SHA-256 (refresh tokens are already random, don't need bcrypt)
 *
 * @param token - Unhashed refresh token
 * @returns SHA-256 hash of the token (hex)
 *
 * @example
 * const hashed = hashRefreshToken('7f3c4e2a...');
 * // => 'a5b3c8d...' (64-char hex string)
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parse time string to milliseconds
 * Supports: '15m', '7d', '30s', '2h'
 *
 * @param expiry - Time string (e.g., '15m', '7d')
 * @returns Milliseconds
 */
function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid expiry format: ${expiry}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const multiplier = multipliers[unit];
  if (!multiplier) {
    throw new Error(`Invalid expiry unit: ${unit}`);
  }

  return value * multiplier;
}

/**
 * Payload for temporary MFA login token
 */
export interface MFATempTokenPayload {
  userId: string;
  type: 'mfa_login';
}

/**
 * Generate temporary token for MFA verification during login
 * Short lived (5 minutes)
 */
export function generateMFATempToken(userId: string): string {
  const payload: MFATempTokenPayload = {
    userId,
    type: 'mfa_login',
  };

  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: '5m',
    issuer: 'revenueplug',
    subject: userId,
  });
}

/**
 * Verify temporary MFA token
 */
export function verifyMFATempToken(token: string): MFATempTokenPayload {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'revenueplug',
    }) as MFATempTokenPayload;

    if (decoded.type !== 'mfa_login') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch {
    throw new Error('Invalid or expired MFA token');
  }
}
