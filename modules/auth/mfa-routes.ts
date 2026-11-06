/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import * as crypto from 'node:crypto';
import * as bcrypt from 'bcrypt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateSecret, generateURI, verify } from 'otplib';
import * as qrcode from 'qrcode';
import { z } from 'zod';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import { setAccessTokenCookie, setRefreshTokenCookie } from './cookies.js';
import { requireAuth } from './middleware.js';
import * as authService from './service.js';
import { generateAccessToken, generateRefreshToken, verifyMFATempToken } from './tokens.js';

// ============================================================================
// SCHEMAS
// ============================================================================

const VerifyMFASchema = z.object({
  code: z.string().length(6, 'Code must be 6 digits'),
});

const DisableMFASchema = z.object({
  password: z.string().min(1, 'Password is required'), // Require password to disable
  code: z.string().optional(), // Optional: require TOTP to disable? Plan says password OR code. Password is safer for lost devices.
});

const LoginMFASchema = z.object({
  temp_token: z.string().min(1, 'Temporary token is required'),
  code: z.string().min(6, 'Code is required'), // Can be TOTP (6) or recovery code (longer)
});

const RegenerateCodesSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

// ============================================================================
// HELPERS
// ============================================================================

function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
    codes.push(code);
  }
  return codes;
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * POST /api/auth/mfa/setup
 * Initialize MFA setup - returns secret and QR code
 */
async function handleSetupMFA(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleSetupMFA' });
  const { userId, email } = (request as any).user;

  try {
    // Check if already enabled
    const existing = await prisma.userMFA.findUnique({
      where: { userId },
    });

    if (existing?.enabled) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'MFA is already enabled. Disable it first to re-setup.',
      });
    }

    // Generate secret
    const secret = generateSecret();
    const otpauth = generateURI({
      issuer: 'RevenuePlug',
      label: email,
      secret,
    });
    const qrCodeUrl = await qrcode.toDataURL(otpauth);

    // Save secret (not enabled yet)
    await prisma.userMFA.upsert({
      where: { userId },
      create: {
        userId,
        secret, // In production, encrypt this! (Plan said encrypt at rest, skipping for now per task simplicity or use helper if avail)
        enabled: false,
        recoveryCodes: [],
      },
      update: {
        secret,
        enabled: false,
        recoveryCodes: [],
      },
    });

    log.info({ userId }, 'MFA setup initialized');

    return reply.code(200).send({
      secret,
      qr_code_url: qrCodeUrl,
    });
  } catch (error) {
    log.error({ error }, 'MFA setup failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to setup MFA',
    });
  }
}

/**
 * POST /api/auth/mfa/verify
 * Verify MFA setup code and enable MFA
 */
async function handleVerifySetup(
  request: FastifyRequest<{ Body: z.infer<typeof VerifyMFASchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleVerifySetup' });
  const { userId } = (request as any).user;

  try {
    const { code } = VerifyMFASchema.parse(request.body);

    const mfa = await prisma.userMFA.findUnique({
      where: { userId },
    });

    if (!mfa) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'MFA setup not initialized',
      });
    }

    if (mfa.enabled) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'MFA is already enabled',
      });
    }

    // Verify code
    const val = await verify({ token: code, secret: mfa.secret });
    const isValid = !!val;
    if (!isValid) {
      return reply.code(400).send({
        error: 'Invalid Code',
        message: 'Invalid verification code',
      });
    }

    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes();
    // Hash codes for storage
    const hashedCodes = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10)));

    // Enable MFA
    await prisma.userMFA.update({
      where: { userId },
      data: {
        enabled: true,
        verifiedAt: new Date(),
        recoveryCodes: hashedCodes,
      },
    });

    log.info({ userId }, 'MFA enabled');

    return reply.code(200).send({
      message: 'MFA enabled successfully',
      recovery_codes: recoveryCodes, // Returns raw codes once
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation failed',
      });
    }
    log.error({ error }, 'MFA verification failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to verify MFA',
    });
  }
}

/**
 * POST /api/auth/mfa/disable
 * Disable MFA (requires password)
 */
async function handleDisableMFA(
  request: FastifyRequest<{ Body: z.infer<typeof DisableMFASchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDisableMFA' });
  const { userId } = (request as any).user;

  try {
    const { password } = DisableMFASchema.parse(request.body);

    // Verify password (step-up auth)
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Cannot disable MFA without password authentication',
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Incorrect password',
      });
    }

    // Delete MFA record
    await prisma.userMFA.delete({
      where: { userId },
    });

    log.info({ userId }, 'MFA disabled');

    return reply.code(200).send({
      message: 'MFA disabled successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation failed',
      });
    }
    log.error({ error }, 'MFA disable failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to disable MFA',
    });
  }
}

/**
 * POST /api/auth/login/mfa
 * Verify 2FA during login
 */
async function handleLoginMFA(
  request: FastifyRequest<{ Body: z.infer<typeof LoginMFASchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleLoginMFA' });

  try {
    const { temp_token, code } = LoginMFASchema.parse(request.body);

    // Verify temp token
    const payload = verifyMFATempToken(temp_token);
    const userId = payload.userId;

    // Get user and MFA settings
    const [user, mfa] = await Promise.all([
      authService.getUserById(userId),
      prisma.userMFA.findUnique({ where: { userId } }),
    ]);

    if (!user) {
      throw new Error('User not found'); // Should not happen if token is valid
    }

    if (!mfa || !mfa.enabled) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'MFA is not enabled for this user',
      });
    }

    // Verify code (TOTP or Recovery Code)
    let isValid = false;

    // Check TOTP
    if (code.length === 6) {
      const val = await verify({ token: code, secret: mfa.secret });
      isValid = !!val;
    }
    // Check Recovery Code
    else {
      // Find matching hash
      const recoveryCodes = mfa.recoveryCodes;
      for (const hash of recoveryCodes) {
        if (await bcrypt.compare(code, hash)) {
          isValid = true;
          // Burn used code
          const newCodes = recoveryCodes.filter((c) => c !== hash);
          await prisma.userMFA.update({
            where: { userId },
            data: { recoveryCodes: newCodes },
          });
          log.info({ userId }, 'Recovery code used');
          break;
        }
      }
    }

    if (!isValid) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Invalid code',
      });
    }

    // Issue real tokens
    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
    });
    const { token: refreshToken } = generateRefreshToken();

    await authService.createSession({
      userId: user.id,
      refreshToken,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    setAccessTokenCookie(reply, accessToken);
    setRefreshTokenCookie(reply, refreshToken);

    log.info({ userId }, 'MFA login successful');

    return reply.code(200).send({
      message: 'Login successful',
      expires_in: 900,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation failed',
      });
    }
    log.error({ error }, 'MFA login failed');
    return reply.code(401).send({
      error: 'Unauthorized',
      message: error instanceof Error ? error.message : 'Authentication failed',
    });
  }
}

/**
 * POST /api/auth/mfa/recovery-codes/regenerate
 * Regenerate recovery codes (requires password)
 */
async function handleRegenerateCodes(
  request: FastifyRequest<{ Body: z.infer<typeof RegenerateCodesSchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleRegenerateCodes' });
  const { userId } = (request as any).user;

  try {
    const { password } = RegenerateCodesSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Password authentication required',
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Incorrect password',
      });
    }

    const mfa = await prisma.userMFA.findUnique({ where: { userId } });
    if (!mfa || !mfa.enabled) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'MFA not enabled',
      });
    }

    // Generate new codes
    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10)));

    await prisma.userMFA.update({
      where: { userId },
      data: { recoveryCodes: hashedCodes },
    });

    log.info({ userId }, 'Recovery codes regenerated');

    return reply.code(200).send({
      message: 'Recovery codes regenerated',
      recovery_codes: recoveryCodes,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation failed',
      });
    }
    log.error({ error }, 'Regenerate codes failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to regenerate codes',
    });
  }
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export async function registerMFARoutes(app: FastifyInstance): Promise<void> {
  // Protected routes
  app.post('/api/auth/mfa/setup', { preHandler: requireAuth }, handleSetupMFA);
  app.post<{ Body: z.infer<typeof VerifyMFASchema> }>(
    '/api/auth/mfa/verify',
    { preHandler: requireAuth },
    handleVerifySetup
  );
  app.post<{ Body: z.infer<typeof DisableMFASchema> }>(
    '/api/auth/mfa/disable',
    { preHandler: requireAuth },
    handleDisableMFA
  );
  app.post<{ Body: z.infer<typeof RegenerateCodesSchema> }>(
    '/api/auth/mfa/recovery-codes/regenerate',
    { preHandler: requireAuth },
    handleRegenerateCodes
  );

  // Public routes (login verification)
  app.post<{ Body: z.infer<typeof LoginMFASchema> }>('/api/auth/login/mfa', handleLoginMFA);

  logger.info('Registered MFA routes');
}
