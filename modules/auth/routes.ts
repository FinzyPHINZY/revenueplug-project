import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import {
  clearAuthCookies,
  getRefreshTokenFromCookies,
  setAccessTokenCookie,
  setRefreshTokenCookie,
} from './cookies.js';
import { sendPasswordResetEmail } from './email.js';
import { getAuthUser, requireAuth } from './middleware.js';
import { validatePasswordStrength } from './password.js';
import * as authService from './service.js';
import {
  generateAccessToken,
  generateMFATempToken,
  generateRefreshToken,
  hashRefreshToken,
} from './tokens.js';

const RegisterBodySchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  name: z.string().optional(),
});

const LoginBodySchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

const RefreshBodySchema = z
  .object({
    refresh_token: z.string().optional(),
  })
  .optional();

const VerifyEmailQuerySchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

const ForgotPasswordBodySchema = z.object({
  email: z.string().email('Invalid email address'),
});

const ResetPasswordBodySchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  new_password: z.string().min(1, 'New password is required'),
});

const UpdateProfileBodySchema = z.object({
  name: z.string().optional(),
  email: z.string().email('Invalid email address').optional(),
});

// POST /api/auth/register - Register new user
async function handleRegister(
  request: FastifyRequest<{ Body: z.infer<typeof RegisterBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleRegister' });

  try {
    const body = RegisterBodySchema.parse(request.body);

    const passwordValidation = validatePasswordStrength(body.password);
    if (!passwordValidation.valid) {
      return reply.code(400).send({
        error: 'Weak password',
        message: passwordValidation.errors.join(', '),
        errors: passwordValidation.errors,
      });
    }

    const { user } = await authService.createUser({
      email: body.email,
      password: body.password,
      name: body.name,
    });

    log.info({ userId: user.id, email: user.email }, 'User registered');

    return reply.code(201).send({
      message: 'Registration successful. Please check your email to verify your account.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    log.error({ error }, 'Registration failed');

    if (error instanceof Error && error.message === 'Email already registered') {
      return reply.code(409).send({
        error: 'Email already registered',
        message: 'An account with this email already exists',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to register user',
    });
  }
}

// GET /api/auth/verify-email - Verify email with token
async function handleVerifyEmail(
  request: FastifyRequest<{
    Querystring: z.infer<typeof VerifyEmailQuerySchema>;
  }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleVerifyEmail' });

  try {
    const query = VerifyEmailQuerySchema.parse(request.query);

    const user = await authService.verifyEmail(query.token);

    log.info({ userId: user.id }, 'Email verified');

    return reply.code(200).send({
      message: 'Email verified successfully. You can now log in.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        email_verified: true,
      },
    });
  } catch (error) {
    log.error({ error }, 'Email verification failed');

    return reply.code(400).send({
      error: 'Verification failed',
      message: error instanceof Error ? error.message : 'Invalid or expired verification token',
    });
  }
}

// POST /api/auth/login - Login with email and password
async function handleLogin(
  request: FastifyRequest<{ Body: z.infer<typeof LoginBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleLogin' });

  try {
    const body = LoginBodySchema.parse(request.body);

    const user = await authService.validateCredentials(body.email, body.password);

    if (!user.emailVerified) {
      return reply.code(403).send({
        error: 'Email not verified',
        message: 'Please verify your email before logging in',
      });
    }

    // Check for MFA
    const mfa = await prisma.userMFA.findUnique({
      where: { userId: user.id },
    });

    if (mfa && mfa.enabled) {
      const tempToken = generateMFATempToken(user.id);
      return reply.code(200).send({
        message: 'MFA verification required',
        mfa_required: true,
        temp_token: tempToken,
      });
    }

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

    log.info({ userId: user.id, email: user.email }, 'User logged in');

    return reply.code(200).send({
      message: 'Login successful',
      expires_in: 900, // 15 minutes in seconds
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    log.error({ error }, 'Login failed');

    if (error instanceof Error && error.message === 'Invalid credentials') {
      return reply.code(401).send({
        error: 'Invalid credentials',
        message: 'Invalid email or password',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to login',
    });
  }
}

// POST /api/auth/refresh - Refresh access token using refresh token
async function handleRefresh(
  request: FastifyRequest<{ Body: z.infer<typeof RefreshBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleRefresh' });

  try {
    const parseResult = RefreshBodySchema.safeParse(request.body ?? {});
    const body = parseResult.success ? parseResult.data : {};
    const refreshToken = getRefreshTokenFromCookies(request) || body?.refresh_token;

    if (!refreshToken) {
      return reply.code(401).send({
        error: 'Missing refresh token',
        message: 'Refresh token is required',
      });
    }

    const result = await authService.validateRefreshToken(refreshToken);

    if (!result) {
      clearAuthCookies(reply);
      return reply.code(401).send({
        error: 'Invalid refresh token',
        message: 'Refresh token is invalid or expired',
      });
    }

    const { user } = result;

    const accessToken = generateAccessToken({
      id: user.id,
      email: user.email,
    });

    setAccessTokenCookie(reply, accessToken);

    log.info({ userId: user.id }, 'Access token refreshed');

    return reply.code(200).send({
      message: 'Token refreshed successfully',
      expires_in: 900, // 15 minutes in seconds
    });
  } catch (error) {
    log.error({ error }, 'Token refresh failed');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to refresh token',
    });
  }
}

// POST /api/auth/logout - Logout (invalidate refresh token)
async function handleLogout(
  request: FastifyRequest<{ Body: z.infer<typeof RefreshBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleLogout' });

  try {
    const parseResult = RefreshBodySchema.safeParse(request.body ?? {});
    const body = parseResult.success ? parseResult.data : {};
    const refreshToken = getRefreshTokenFromCookies(request) || body?.refresh_token;

    if (refreshToken) {
      const hashedToken = hashRefreshToken(refreshToken);

      const session = await prisma.session.findUnique({
        where: { refreshToken: hashedToken },
      });

      if (session) {
        await authService.deleteSession(session.id);
        log.info({ sessionId: session.id }, 'User logged out');
      }
    }

    clearAuthCookies(reply);

    return reply.code(200).send({
      message: 'Logged out successfully',
    });
  } catch (error) {
    log.error({ error }, 'Logout failed');

    return reply.code(200).send({
      message: 'Logged out successfully',
    });
  }
}

// POST /api/auth/forgot-password - Request password reset email
async function handleForgotPassword(
  request: FastifyRequest<{ Body: z.infer<typeof ForgotPasswordBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleForgotPassword' });

  try {
    const body = ForgotPasswordBodySchema.parse(request.body);

    const user = await authService.getUserByEmail(body.email);
    if (!user) {
      log.info({ email: body.email }, 'Password reset requested for non-existent email');
      return reply.code(200).send({
        message: 'If an account with that email exists, a password reset link has been sent.',
      });
    }

    const token = await authService.createVerificationToken(user.id, 'PASSWORD_RESET');

    await sendPasswordResetEmail(user.email, user.name, token);

    log.info({ userId: user.id }, 'Password reset email sent');

    return reply.code(200).send({
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  } catch (error) {
    log.error({ error }, 'Forgot password failed');

    return reply.code(200).send({
      message: 'If an account with that email exists, a password reset link has been sent.',
    });
  }
}

// POST /api/auth/reset-password - Reset password with token
async function handleResetPassword(
  request: FastifyRequest<{ Body: z.infer<typeof ResetPasswordBodySchema> }>,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleResetPassword' });

  try {
    const body = ResetPasswordBodySchema.parse(request.body);

    const passwordValidation = validatePasswordStrength(body.new_password);
    if (!passwordValidation.valid) {
      return reply.code(400).send({
        error: 'Weak password',
        message: passwordValidation.errors.join(', '),
        errors: passwordValidation.errors,
      });
    }

    const user = await authService.resetPassword(body.token, body.new_password);

    log.info({ userId: user.id }, 'Password reset successfully');

    return reply.code(200).send({
      message: 'Password reset successfully. You can now log in with your new password.',
    });
  } catch (error) {
    log.error({ error }, 'Password reset failed');

    return reply.code(400).send({
      error: 'Reset failed',
      message: error instanceof Error ? error.message : 'Invalid or expired reset token',
    });
  }
}

// GET /api/users/me - Get current user profile (protected route)
async function handleGetProfile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetProfile' });

  try {
    const { userId } = getAuthUser(request);

    const user = await authService.getUserById(userId);

    if (!user) {
      return reply.code(404).send({
        error: 'User not found',
        message: 'User account no longer exists',
      });
    }

    log.info({ userId }, 'Profile retrieved');

    return reply.code(200).send({
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerified,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Get profile failed');

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to get profile',
    });
  }
}

// PATCH /api/users/me - Update user profile (protected route)
async function handleUpdateProfile(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleUpdateProfile' });

  try {
    const { userId } = getAuthUser(request);

    const body = UpdateProfileBodySchema.parse(request.body);

    const user = await authService.updateUser(userId, body);

    log.info({ userId }, 'Profile updated');

    return reply.code(200).send({
      id: user.id,
      email: user.email,
      name: user.name,
      email_verified: user.emailVerified,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    });
  } catch (error) {
    log.error({ error }, 'Update profile failed');

    if (error instanceof Error && error.message === 'Email already in use') {
      return reply.code(409).send({
        error: 'Email already in use',
        message: 'An account with this email already exists',
      });
    }

    return reply.code(500).send({
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : 'Failed to update profile',
    });
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // public routes
  app.post('/api/auth/register', handleRegister);
  app.get('/api/auth/verify-email', handleVerifyEmail);
  app.post('/api/auth/login', handleLogin);
  app.post('/api/auth/refresh', handleRefresh);
  app.post('/api/auth/logout', handleLogout);
  app.post('/api/auth/forgot-password', handleForgotPassword);
  app.post('/api/auth/reset-password', handleResetPassword);

  // protected routes (require authentication)
  app.get('/api/users/me', { preHandler: requireAuth }, handleGetProfile);
  app.patch('/api/users/me', { preHandler: requireAuth }, handleUpdateProfile);

  logger.info('Registered authentication routes');
}
