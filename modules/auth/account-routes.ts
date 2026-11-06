/**
 * Account Settings Routes
 * Endpoints for password management, preferences, sessions, OAuth connections, MFA
 */

import crypto from 'node:crypto';
import type { EmailDigestFrequency, OAuthProvider } from '@prisma/client';
import bcrypt from 'bcrypt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../infrastructure/postgres/index.js';
import { logger } from '../../shared/logger/index.js';
import type { AuthUser } from './middleware.js';
import { requireAuth } from './middleware.js';
import * as authService from './service.js';

// ============================================================================
// SCHEMAS
// ============================================================================

const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});

const VerifyPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

const UpdatePreferencesSchema = z.object({
  emailDigest: z.enum(['NONE', 'DAILY', 'WEEKLY']).optional(),
  emailOnHighRisk: z.boolean().optional(),
  emailOnPaymentFailed: z.boolean().optional(),
  emailOnCampaignConverted: z.boolean().optional(),
  emailOnTrialEnding: z.boolean().optional(),
  emailOnMilestones: z.boolean().optional(),
  inAppOnHighRisk: z.boolean().optional(),
  inAppOnPaymentFailed: z.boolean().optional(),
  inAppOnCampaignConverted: z.boolean().optional(),
});

// Helper to get authenticated user
function getUser(request: FastifyRequest): AuthUser {
  return (request as FastifyRequest & { user: AuthUser }).user;
}

// ============================================================================
// PASSWORD MANAGEMENT
// ============================================================================

/**
 * POST /api/auth/change-password
 * Change password for users who already have a password
 */
async function handleChangePassword(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleChangePassword' });
  const { userId } = getUser(request);

  try {
    const { current_password, new_password } = ChangePasswordSchema.parse(request.body);

    // Get user with password
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    if (!user.password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'You do not have a password set. Use the set-password endpoint instead.',
      });
    }

    // Verify current password
    const isValid = await bcrypt.compare(current_password, user.password);
    if (!isValid) {
      log.warn({ userId }, 'Incorrect current password');
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Current password is incorrect',
      });
    }

    // Update password (this also invalidates all sessions for security)
    await authService.updatePassword(userId, new_password);

    log.info({ userId }, 'Password changed successfully');

    return reply.code(200).send({
      message: 'Password updated successfully. Please log in again.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message ?? 'Validation Error',
      });
    }
    log.error({ error }, 'Change password failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to change password',
    });
  }
}

/**
 * POST /api/auth/set-password
 * Set password for OAuth-only users who don't have a password
 */
async function handleSetPassword(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleSetPassword' });
  const { userId } = getUser(request);

  try {
    const { password } = SetPasswordSchema.parse(request.body);

    // Get user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });

    if (!user) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'User not found',
      });
    }

    if (user.password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'You already have a password set. Use the change-password endpoint.',
      });
    }

    // Hash and set password
    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    log.info({ userId }, 'Password set for OAuth user');

    return reply.code(200).send({
      message: 'Password set successfully. You can now log in with email and password.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message ?? 'Validation Error',
      });
    }
    log.error({ error }, 'Set password failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to set password',
    });
  }
}

/**
 * POST /api/auth/verify-password
 * Re-authenticate for sensitive actions (step-up auth)
 */
async function handleVerifyPassword(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleVerifyPassword' });
  const { userId } = getUser(request);

  try {
    const { password } = VerifyPasswordSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });

    if (!user || !user.password) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Password verification not available',
      });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      log.warn({ userId }, 'Password verification failed');
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Password is incorrect',
      });
    }

    log.info({ userId }, 'Password verified for sensitive action');

    return reply.code(200).send({
      message: 'Password verified',
      verified: true,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message ?? 'Validation Error',
      });
    }
    log.error({ error }, 'Verify password failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to verify password',
    });
  }
}

// ============================================================================
// USER PREFERENCES
// ============================================================================

/**
 * GET /api/users/preferences
 * Get user notification preferences
 */
async function handleGetPreferences(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetPreferences' });
  const { userId } = getUser(request);

  try {
    const preferences = await prisma.userNotificationPreference.findUnique({
      where: { userId },
    });

    if (!preferences) {
      // Return defaults if no preferences exist
      return reply.code(200).send({
        preferences: {
          emailDigest: 'DAILY',
          emailOnHighRisk: true,
          emailOnPaymentFailed: true,
          emailOnCampaignConverted: true,
          emailOnTrialEnding: true,
          emailOnMilestones: true,
          inAppOnHighRisk: true,
          inAppOnPaymentFailed: true,
          inAppOnCampaignConverted: true,
        },
      });
    }

    return reply.code(200).send({
      preferences: {
        emailDigest: preferences.emailDigest,
        emailOnHighRisk: preferences.emailOnHighRisk,
        emailOnPaymentFailed: preferences.emailOnPaymentFailed,
        emailOnCampaignConverted: preferences.emailOnCampaignConverted,
        emailOnTrialEnding: preferences.emailOnTrialEnding,
        emailOnMilestones: preferences.emailOnMilestones,
        inAppOnHighRisk: preferences.inAppOnHighRisk,
        inAppOnPaymentFailed: preferences.inAppOnPaymentFailed,
        inAppOnCampaignConverted: preferences.inAppOnCampaignConverted,
      },
    });
  } catch (error) {
    log.error({ error }, 'Get preferences failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to get preferences',
    });
  }
}

/**
 * PATCH /api/users/preferences
 * Update user notification preferences
 */
async function handleUpdatePreferences(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleUpdatePreferences' });
  const { userId } = getUser(request);

  try {
    const updates = UpdatePreferencesSchema.parse(request.body);

    // Convert emailDigest to proper enum type
    const data: Record<string, unknown> = {};
    if (updates.emailOnHighRisk !== undefined) data['emailOnHighRisk'] = updates.emailOnHighRisk;
    if (updates.emailOnPaymentFailed !== undefined)
      data['emailOnPaymentFailed'] = updates.emailOnPaymentFailed;
    if (updates.emailOnCampaignConverted !== undefined)
      data['emailOnCampaignConverted'] = updates.emailOnCampaignConverted;
    if (updates.emailOnTrialEnding !== undefined)
      data['emailOnTrialEnding'] = updates.emailOnTrialEnding;
    if (updates.emailOnMilestones !== undefined)
      data['emailOnMilestones'] = updates.emailOnMilestones;
    if (updates.inAppOnHighRisk !== undefined) data['inAppOnHighRisk'] = updates.inAppOnHighRisk;
    if (updates.inAppOnPaymentFailed !== undefined)
      data['inAppOnPaymentFailed'] = updates.inAppOnPaymentFailed;
    if (updates.inAppOnCampaignConverted !== undefined)
      data['inAppOnCampaignConverted'] = updates.inAppOnCampaignConverted;
    if (updates.emailDigest) data['emailDigest'] = updates.emailDigest as EmailDigestFrequency;

    const preferences = await prisma.userNotificationPreference.upsert({
      where: { userId },
      create: {
        user: { connect: { id: userId } },
        ...data,
      },
      update: data,
    });

    log.info({ userId }, 'Preferences updated');

    return reply.code(200).send({
      message: 'Preferences updated',
      preferences: {
        emailDigest: preferences.emailDigest,
        emailOnHighRisk: preferences.emailOnHighRisk,
        emailOnPaymentFailed: preferences.emailOnPaymentFailed,
        emailOnCampaignConverted: preferences.emailOnCampaignConverted,
        emailOnTrialEnding: preferences.emailOnTrialEnding,
        emailOnMilestones: preferences.emailOnMilestones,
        inAppOnHighRisk: preferences.inAppOnHighRisk,
        inAppOnPaymentFailed: preferences.inAppOnPaymentFailed,
        inAppOnCampaignConverted: preferences.inAppOnCampaignConverted,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message ?? 'Validation Error',
      });
    }
    log.error({ error }, 'Update preferences failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to update preferences',
    });
  }
}

// ============================================================================
// OAUTH CONNECTIONS
// ============================================================================

/**
 * GET /api/auth/connections
 * List OAuth providers and connected accounts
 */
async function handleGetConnections(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetConnections' });
  const { userId } = getUser(request);

  try {
    const [user, oauthAccounts] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { password: true },
      }),
      prisma.oAuthAccount.findMany({
        where: { userId },
        select: {
          provider: true,
          createdAt: true,
        },
      }),
    ]);

    const hasPassword = !!user?.password;
    const connectedProviders = new Set(oauthAccounts.map((a) => a.provider));

    // Build response with all providers showing connected status
    const connections = [
      {
        provider: 'GOOGLE',
        connected: connectedProviders.has('GOOGLE'),
        connected_at: oauthAccounts.find((a) => a.provider === 'GOOGLE')?.createdAt || null,
      },
      {
        provider: 'SLACK',
        connected: connectedProviders.has('SLACK'),
        connected_at: oauthAccounts.find((a) => a.provider === 'SLACK')?.createdAt || null,
      },
      {
        provider: 'MICROSOFT',
        connected: connectedProviders.has('MICROSOFT'),
        connected_at: oauthAccounts.find((a) => a.provider === 'MICROSOFT')?.createdAt || null,
      },
    ];

    // Can disconnect if has password OR has multiple OAuth accounts
    const canDisconnect = hasPassword || oauthAccounts.length > 1;

    return reply.code(200).send({
      connections,
      can_disconnect: canDisconnect,
      has_password: hasPassword,
    });
  } catch (error) {
    log.error({ error }, 'Get connections failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to get connections',
    });
  }
}

/**
 * DELETE /api/auth/connections/:provider
 * Disconnect an OAuth provider
 */
async function handleDisconnectProvider(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleDisconnectProvider' });
  const { userId } = getUser(request);
  const { provider } = request.params as { provider: string };

  try {
    const providerUpper = provider.toUpperCase() as OAuthProvider;

    // Validate provider
    if (!['GOOGLE', 'SLACK', 'MICROSOFT'].includes(providerUpper)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid provider',
      });
    }

    // Check if user has password or other OAuth accounts
    const [user, oauthAccounts] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { password: true },
      }),
      prisma.oAuthAccount.findMany({
        where: { userId },
      }),
    ]);

    const hasPassword = !!user?.password;
    const otherOAuthAccounts = oauthAccounts.filter((a) => a.provider !== providerUpper);

    if (!hasPassword && otherOAuthAccounts.length === 0) {
      return reply.code(400).send({
        error: 'Bad Request',
        message:
          'Cannot disconnect - this is your only authentication method. Set a password first.',
      });
    }

    // Delete the OAuth account
    const deleted = await prisma.oAuthAccount.deleteMany({
      where: {
        userId,
        provider: providerUpper,
      },
    });

    if (deleted.count === 0) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'OAuth connection not found',
      });
    }

    log.info({ userId, provider: providerUpper }, 'OAuth provider disconnected');

    return reply.code(200).send({
      message: `Disconnected from ${provider}`,
    });
  } catch (error) {
    log.error({ error }, 'Disconnect provider failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to disconnect provider',
    });
  }
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * GET /api/auth/sessions
 * List active sessions
 */
async function handleGetSessions(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleGetSessions' });
  const { userId } = getUser(request);

  try {
    const sessions = await prisma.session.findMany({
      where: {
        userId,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        device: true,
        location: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    // Mark the most recently used session as current
    const currentSessionId = sessions[0]?.id;

    const sessionList = sessions.map((session) => ({
      id: session.id,
      device: session.device || parseUserAgent(session.userAgent),
      ip_address: maskIpAddress(session.ipAddress),
      location: session.location || 'Unknown',
      last_active: session.lastUsedAt,
      created_at: session.createdAt,
      current: session.id === currentSessionId,
    }));

    return reply.code(200).send({
      sessions: sessionList,
    });
  } catch (error) {
    log.error({ error }, 'Get sessions failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to get sessions',
    });
  }
}

/**
 * DELETE /api/auth/sessions/:sessionId
 * Revoke a specific session
 */
async function handleRevokeSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleRevokeSession' });
  const { userId } = getUser(request);
  const { sessionId } = request.params as { sessionId: string };

  try {
    // Verify session belongs to user
    const session = await prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!session) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Session not found',
      });
    }

    await authService.deleteSession(sessionId);

    log.info({ userId, sessionId }, 'Session revoked');

    return reply.code(200).send({
      message: 'Session revoked',
    });
  } catch (error) {
    log.error({ error }, 'Revoke session failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to revoke session',
    });
  }
}

/**
 * DELETE /api/auth/sessions
 * Revoke all other sessions (except current)
 */
async function handleRevokeAllSessions(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const log = logger.child({ operation: 'handleRevokeAllSessions' });
  const { userId } = getUser(request);

  try {
    // Get current session (most recently active)
    const currentSession = await prisma.session.findFirst({
      where: {
        userId,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true },
    });

    // Delete all sessions except current
    const deleted = await prisma.session.deleteMany({
      where: {
        userId,
        id: currentSession ? { not: currentSession.id } : undefined,
      },
    });

    log.info({ userId, revokedCount: deleted.count }, 'All other sessions revoked');

    return reply.code(200).send({
      message: 'All other sessions revoked',
      revoked_count: deleted.count,
    });
  } catch (error) {
    log.error({ error }, 'Revoke all sessions failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to revoke sessions',
    });
  }
}

// ============================================================================
// ACCOUNT DELETION
// ============================================================================

const DeleteAccountSchema = z.object({
  password: z.string().optional(), // Optional if user has no password
});

const CancelDeletionSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

/**
 * POST /api/users/me/delete-request
 * Request account deletion (soft delete + grace period)
 */
async function handleDeleteRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleDeleteRequest' });
  const { userId } = getUser(request);

  try {
    const { password } = DeleteAccountSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true, email: true },
    });

    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }

    // Security check: must provide password if user has one
    if (user.password) {
      if (!password) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Password required to delete account',
        });
      }
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return reply.code(401).send({
          error: 'Unauthorized',
          message: 'Incorrect password',
        });
      }
    }

    // Generate deletion token
    const deleteToken = crypto.randomBytes(32).toString('hex');
    const deleteDate = new Date();
    deleteDate.setDate(deleteDate.getDate() + 30); // 30 day grace period

    await prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: deleteDate,
        deleteToken,
      },
    });

    // Logout all sessions (security best practice)
    await authService.deleteAllUserSessions(userId);

    // In a real app, send email with cancel link here -> /cancel-deletion?token=...

    log.info({ userId, deleteDate }, 'Account deletion requested');

    return reply.code(200).send({
      message: 'Account scheduled for deletion in 30 days. Confirmation email sent.',
      deletedAt: deleteDate,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation Error',
      });
    }
    log.error({ error }, 'Delete request failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to request deletion',
    });
  }
}

/**
 * POST /api/users/me/cancel-deletion
 * Cancel pending account deletion
 */
async function handleCancelDeletion(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleCancelDeletion' });
  const { userId } = getUser(request);

  try {
    const { token } = CancelDeletionSchema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { deleteToken: true },
    });

    if (!user || user.deleteToken !== token) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid or expired deletion token',
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        deletedAt: null,
        deleteToken: null,
      },
    });

    log.info({ userId }, 'Account deletion cancelled');

    return reply.code(200).send({
      message: 'Account deletion cancelled.',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Validation Error',
        message: error.errors[0]?.message || 'Validation Error',
      });
    }
    log.error({ error }, 'Cancel deletion failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to cancel deletion',
    });
  }
}

/**
 * GET /api/users/me/export
 * Export all user data (GDPR)
 */
async function handleExportData(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const log = logger.child({ operation: 'handleExportData' });
  const { userId } = getUser(request);

  try {
    // Fetch all user related data
    const [user, preferences, connections, sessions] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          emailVerified: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.userNotificationPreference.findUnique({ where: { userId } }),
      prisma.oAuthAccount.findMany({
        where: { userId },
        select: { provider: true, providerAccountId: true, createdAt: true },
      }),
      prisma.session.findMany({
        where: { userId },
        select: {
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          lastUsedAt: true,
        },
      }),
    ]);

    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }

    const exportData = {
      user,
      preferences,
      connections,
      sessions,
      exportedAt: new Date().toISOString(),
    };

    return reply.code(200).send(exportData);
  } catch (error) {
    log.error({ error }, 'Data export failed');
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Failed to export data',
    });
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Parse user agent string to human-readable device
 */
function parseUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  // Basic parsing - in production use ua-parser-js
  const isChrome = userAgent.includes('Chrome');
  const isFirefox = userAgent.includes('Firefox');
  const isSafari = userAgent.includes('Safari') && !isChrome;
  const isEdge = userAgent.includes('Edg');

  const isWindows = userAgent.includes('Windows');
  const isMac = userAgent.includes('Mac');
  const isLinux = userAgent.includes('Linux');
  const isIPhone = userAgent.includes('iPhone');
  const isAndroid = userAgent.includes('Android');

  let browser = 'Browser';
  if (isEdge) browser = 'Edge';
  else if (isChrome) browser = 'Chrome';
  else if (isFirefox) browser = 'Firefox';
  else if (isSafari) browser = 'Safari';

  let os = 'Device';
  if (isIPhone) os = 'iPhone';
  else if (isAndroid) os = 'Android';
  else if (isMac) os = 'macOS';
  else if (isWindows) os = 'Windows';
  else if (isLinux) os = 'Linux';

  return `${browser} on ${os}`;
}

/**
 * Mask IP address for privacy (show only first two octets)
 */
function maskIpAddress(ip: string | null): string {
  if (!ip) return 'Unknown';
  const parts = ip.split('.');
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.x.x`;
}

// ============================================================================
// ROUTE REGISTRATION
// ============================================================================

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  // Password management (all protected)
  app.post('/api/auth/change-password', { preHandler: requireAuth }, handleChangePassword);
  app.post('/api/auth/set-password', { preHandler: requireAuth }, handleSetPassword);
  app.post('/api/auth/verify-password', { preHandler: requireAuth }, handleVerifyPassword);

  // User preferences
  app.get('/api/users/preferences', { preHandler: requireAuth }, handleGetPreferences);
  app.patch('/api/users/preferences', { preHandler: requireAuth }, handleUpdatePreferences);

  // OAuth connections
  app.get('/api/auth/connections', { preHandler: requireAuth }, handleGetConnections);
  app.delete(
    '/api/auth/connections/:provider',
    { preHandler: requireAuth },
    handleDisconnectProvider
  );

  // Sessions
  app.get('/api/auth/sessions', { preHandler: requireAuth }, handleGetSessions);
  app.delete('/api/auth/sessions/:sessionId', { preHandler: requireAuth }, handleRevokeSession);
  app.delete('/api/auth/sessions', { preHandler: requireAuth }, handleRevokeAllSessions);

  // Account Deletion
  app.post('/api/users/me/delete-request', { preHandler: requireAuth }, handleDeleteRequest);
  app.post('/api/users/me/cancel-deletion', { preHandler: requireAuth }, handleCancelDeletion);
  app.get('/api/users/me/export', { preHandler: requireAuth }, handleExportData);

  logger.info('Registered account settings routes');
}
